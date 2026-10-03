import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import express from "@theia/core/shared/express";

import {
  WHITEBOARD_AGENT_TOKENS_PATH,
  WHITEBOARD_GATEWAY_HEADER,
  WHITEBOARD_MCP_PATH,
} from "../common/whiteboard-paths";
import {
  FailedAttemptLimit,
  GatewayGuard,
  agentTokenRoutes,
  mcpEndpoint,
} from "./agent-access";
import { AgentTokenStore } from "./agent-tokens";
import { mcpHandlerLoader } from "./mcp-handler";
import { ReviewServerProcess } from "./review-server-process";

// The built review package (`pnpm --filter @dev.fast/review build`).
const cli = path.resolve(
  __dirname,
  "../../../../../packages/review/dist/cli.js",
);

const SECRET = "gateway-secret-for-tests-0123456789";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

describe(
  "agent access against a real review server",
  { skip: !existsSync(cli) && "build packages/review first" },
  () => {
    let root: string;
    let base: string;
    let tokens: AgentTokenStore;
    let review: ReviewServerProcess;
    let close: () => Promise<void>;
    const logs: string[] = [];

    before(async () => {
      root = await mkdtemp(path.join(tmpdir(), "whiteboard-agent-access-"));
      process.env.DEV_FAST_REVIEW_TELEMETRY_DISABLED = "1";
      review = new ReviewServerProcess({
        cli,
        stateDir: path.join(root, "data", "whiteboard"),
        softwareMaps: false,
      });
      tokens = new AgentTokenStore(
        path.join(root, "data", "agent-tokens.json"),
      );

      const guard = new GatewayGuard(SECRET);
      const app = express();

      app.use(guard.middleware());
      app.use(
        mcpEndpoint({
          tokens,
          reviewServer: () => review.connection(),
          handler: mcpHandlerLoader(cli),
          limit: new FailedAttemptLimit(3),
          log: (line) => logs.push(line),
        }),
      );
      app.use(agentTokenRoutes(tokens));
      app.get("/whiteboard/api/ping", (_request, response) => {
        response.send("pong");
      });

      const server = createServer(app);

      server.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
    });

    after(async () => {
      await close();
      review.stop();
      await rm(root, { recursive: true, force: true });
    });

    /** One JSON-RPC call over Streamable HTTP. */
    async function rpc(
      token: string | undefined,
      method: string,
      params: { [key: string]: Json } = {},
      extraHeaders: Record<string, string> = {},
    ) {
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });

      if (token) headers.set("authorization", `Bearer ${token}`);

      for (const [name, value] of Object.entries(extraHeaders))
        headers.set(name, value);

      const response = await fetch(`${base}${WHITEBOARD_MCP_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params,
        }),
      });

      const text = await response.text();

      return {
        status: response.status,
        response,
        body: text ? JSON.parse(text) : undefined,
      };
    }

    async function tool(
      token: string,
      name: string,
      args: { [key: string]: Json },
    ) {
      const reply = await rpc(token, "tools/call", { name, arguments: args });

      assert.equal(reply.status, 200);

      const result = reply.body.result as {
        isError?: boolean;
        content: { text: string }[];
      };

      return {
        isError: result.isError === true,
        text: result.content[0]?.text ?? "",
      };
    }

    async function admin(
      method: string,
      route = "",
      body?: Json,
      extraHeaders: Record<string, string> = {},
    ) {
      const headers = new Headers({ [WHITEBOARD_GATEWAY_HEADER]: SECRET });

      if (body) headers.set("content-type", "application/json");

      for (const [name, value] of Object.entries(extraHeaders))
        headers.set(name, value);

      const response = await fetch(
        `${base}${WHITEBOARD_AGENT_TOKENS_PATH}${route}`,
        { method, headers, body: body ? JSON.stringify(body) : undefined },
      );

      return { status: response.status, body: await response.json() };
    }

    test("an agent with a token initializes, lists, reads and writes", async () => {
      const created = await admin("POST", "", { name: "ci agent" });

      assert.equal(created.status, 201);

      const token: string = created.body.token;

      const init = await rpc(token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ci", version: "1" },
      });

      assert.equal(init.status, 200);
      assert.equal(init.body.result.serverInfo.name, "whiteboard");
      assert.equal(init.response.headers.get("mcp-session-id"), null);

      const listed = await rpc(token, "tools/list");

      const names: string[] = listed.body.result.tools.map(
        (t: { name: string }) => t.name,
      );

      for (const name of [
        "session_get_instructions",
        "session_list",
        "session_create",
        "session_edit",
      ])
        assert.ok(names.includes(name), name);

      assert.deepEqual(
        JSON.parse((await tool(token, "session_list", {})).text),
        [],
      );

      const repo = path.join(root, "repo");

      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, stdio: "ignore" });

      await mkdir(repo);
      await writeFile(path.join(repo, "a.ts"), "export const a = 1;\n");
      git("init", "-q", "-b", "main");
      git("add", "a.ts");
      git(
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-qm",
        "init",
      );

      const registered = await tool(token, "session_register_repository", {
        path: repo,
      });

      assert.equal(registered.isError, false, registered.text);

      const commandId = randomUUID();

      const input = {
        commandId,
        title: "Authored over HTTP",
        target: {
          kind: "worktree",
          repositoryId: JSON.parse(registered.text).id,
        },
      };

      const first = await tool(token, "session_create", input);

      assert.equal(first.isError, false, first.text);

      // A lost response is retried with the same commandId: no second review.
      const retried = await tool(token, "session_create", input);

      assert.equal(
        JSON.parse(retried.text).sessionId,
        JSON.parse(first.text).sessionId,
      );

      const sessions = JSON.parse((await tool(token, "session_list", {})).text);

      assert.deepEqual(
        sessions.map((s: { title: string }) => s.title),
        ["Authored over HTTP"],
      );
      assert.ok(
        logs.some(
          (line) =>
            line.includes(`token=${created.body.info.id}`) &&
            line.includes("session_create:ok"),
        ),
      );
      assert.ok(
        logs.every(
          (line) =>
            !line.includes(token) && !line.includes("Authored over HTTP"),
        ),
      );

      const listedTokens = await admin("GET");

      assert.ok(listedTokens.body[0].lastUsedAt);
    });

    test("read-only tokens see and run only reading tools", async () => {
      const { body } = await admin("POST", "", {
        name: "reader",
        scope: "read",
      });

      const names: string[] = (
        await rpc(body.token, "tools/list")
      ).body.result.tools.map((t: { name: string }) => t.name);

      assert.ok(names.includes("session_list"));
      assert.ok(!names.includes("session_create"));

      const refused = await tool(body.token, "session_create", {
        commandId: randomUUID(),
        title: "x",
      });

      assert.equal(refused.isError, true);
      assert.match(refused.text, /read-only/);
    });

    test("refuses missing, wrong and revoked tokens", async () => {
      const missing = await rpc(undefined, "tools/list");

      assert.equal(missing.status, 401);
      assert.equal(
        missing.response.headers.get("www-authenticate"),
        'Bearer realm="whiteboard"',
      );

      const basic = await rpc(
        undefined,
        "tools/list",
        {},
        { authorization: "Basic d2hpdGVib2FyZDp4" },
      );

      assert.equal(basic.status, 401);

      const { body } = await admin("POST", "", { name: "short lived" });
      const wrong = `${body.token.slice(0, -1)}${body.token.endsWith("A") ? "B" : "A"}`;

      const forged = await rpc(
        wrong,
        "tools/list",
        {},
        { "x-forwarded-for": "198.51.100.1" },
      );

      assert.equal(forged.status, 401);
      assert.match(
        forged.response.headers.get("www-authenticate") ?? "",
        /invalid_token/,
      );
      assert.equal((await rpc(body.token, "tools/list")).status, 200);

      assert.equal(
        (await admin("POST", `/${body.info.id}/revoke`)).status,
        200,
      );
      assert.equal(
        (
          await rpc(
            body.token,
            "tools/list",
            {},
            { "x-forwarded-for": "198.51.100.2" },
          )
        ).status,
        401,
      );
    });

    test("checks Origin, limits failed attempts and is POST-only", async () => {
      const { body } = await admin("POST", "", { name: "origin" });

      assert.equal(
        (
          await rpc(
            body.token,
            "tools/list",
            {},
            { origin: "https://evil.example" },
          )
        ).status,
        403,
      );

      const get = await fetch(`${base}${WHITEBOARD_MCP_PATH}`, {
        headers: { authorization: `Bearer ${body.token}` },
      });

      assert.equal(get.status, 405);

      const attacker = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };

      for (let attempt = 0; attempt < 3; attempt++)
        assert.equal(
          (
            await rpc(
              "wbat_00000000_" + "A".repeat(43),
              "tools/list",
              {},
              attacker,
            )
          ).status,
          401,
        );

      const blocked = await rpc(body.token, "tools/list", {}, attacker);

      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.response.headers.get("retry-after")) > 0);
      assert.equal((await rpc(body.token, "tools/list")).status, 200);
    });

    test("token management refuses agents and cross-site writes", async () => {
      const { body } = await admin("POST", "", { name: "agent" });
      const bearer = { authorization: `Bearer ${body.token}` };

      assert.equal((await admin("GET", "", undefined, bearer)).status, 403);
      assert.equal(
        (await admin("POST", "", { name: "minted" }, bearer)).status,
        403,
      );
      assert.equal(
        (await admin("POST", `/${body.info.id}/revoke`, undefined, bearer))
          .status,
        403,
      );
      assert.equal(
        (
          await admin(
            "POST",
            "",
            { name: "csrf" },
            { origin: "https://evil.example" },
          )
        ).status,
        403,
      );
      assert.equal((await admin("POST", "", { name: "" })).status, 400);
      assert.equal((await admin("POST", "/zzzzzzzz/revoke")).status, 404);
    });

    test("everything but the MCP endpoint needs the gateway's header", async () => {
      const ping = (
        headers: Record<string, string>,
        route = "/whiteboard/api/ping",
      ) =>
        fetch(`${base}${route}`, { headers }).then(
          (response) => response.status,
        );

      const { body } = await admin("POST", "", { name: "guard" });

      assert.equal(await ping({}), 403);
      assert.equal(await ping({ [WHITEBOARD_GATEWAY_HEADER]: "wrong" }), 403);
      assert.equal(await ping({ [WHITEBOARD_GATEWAY_HEADER]: SECRET }), 200);
      assert.equal(
        await ping({
          [WHITEBOARD_GATEWAY_HEADER]: SECRET,
          authorization: `Bearer ${body.token}`,
        }),
        403,
      );
      assert.equal(
        await ping(
          { authorization: `Bearer ${body.token}` },
          "/Whiteboard/mcp",
        ),
        403,
      );
      assert.equal(
        await ping(
          { authorization: `Bearer ${body.token}` },
          "/whiteboard/mcp/",
        ),
        403,
      );
      assert.equal(await ping({}, WHITEBOARD_AGENT_TOKENS_PATH), 403);
    });
  },
);
