import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ReviewServerDiscovery } from "../server-discovery.js";
import { runHeadlessServer } from "../server/headless-host.js";
import { handleReviewMcpHttpRequest } from "./mcp-http.js";

let root: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-mcp-http-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function reviewServer() {
  const controller = new AbortController();
  const ready = Promise.withResolvers<ReviewServerDiscovery>();

  const running = runHeadlessServer({
    stateDir: path.join(root, "server"),
    signal: controller.signal,
    onReady: ready.resolve,
  });

  stops.push(async () => {
    controller.abort();
    await running;
  });

  return ready.promise;
}

/** An MCP endpoint in front of a running review server, as a web host serves it. */
async function mcpEndpoint(readOnly = false) {
  const discovery = await reviewServer();
  const calls: string[] = [];

  const http = createServer((request, response) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      void handleReviewMcpHttpRequest(
        discovery,
        request,
        response,
        body ? JSON.parse(body) : undefined,
        {
          readOnly,
          onToolCall: (call) => calls.push(`${call.tool}:${call.ok}`),
        },
      );
    });
  });

  http.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  stops.push(() => new Promise<void>((resolve) => http.close(() => resolve())));

  const client = new Client({ name: "test", version: "1" });

  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`),
    ),
  );
  stops.push(() => client.close());

  return { client, calls };
}

/** A one-commit repository to review. */
async function repository() {
  const directory = path.join(root, "repo");

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, stdio: "ignore" });

  await mkdir(directory);
  await writeFile(path.join(directory, "example.ts"), "export const a = 1;\n");
  git("init", "-q", "-b", "main");
  git("add", "example.ts");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "init",
  );

  return directory;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = result.content as { type: string; text: string }[];

  return first?.text ?? "";
}

it("lists, reads and writes over HTTP against a running review server", async () => {
  const { client, calls } = await mcpEndpoint();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);

  expect(names).toEqual(
    expect.arrayContaining([
      "session_get_instructions",
      "whiteboard_status",
      "session_list",
      "session_create",
    ]),
  );

  const before = await client.callTool({ name: "session_list", arguments: {} });

  expect(before.isError).toBeFalsy();
  expect(JSON.parse(text(before))).toEqual([]);

  const registered = await client.callTool({
    name: "session_register_repository",
    arguments: { path: await repository() },
  });

  const { id: repositoryId } = JSON.parse(text(registered)) as { id: string };

  const created = await client.callTool({
    name: "session_create",
    arguments: {
      commandId: randomUUID(),
      title: "Over HTTP",
      target: { kind: "worktree", repositoryId },
    },
  });

  expect({
    isError: created.isError ?? false,
    text: text(created),
  }).toMatchObject({
    isError: false,
  });

  const after = await client.callTool({ name: "session_list", arguments: {} });

  expect(JSON.parse(text(after))).toEqual([
    expect.objectContaining({ title: "Over HTTP" }),
  ]);
  expect(calls).toEqual([
    "session_list:true",
    "session_register_repository:true",
    "session_create:true",
    "session_list:true",
  ]);
});

it("offers and runs only reading tools when read-only", async () => {
  const { client } = await mcpEndpoint(true);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);

  expect(names).toContain("session_list");
  expect(names).not.toContain("session_create");
  expect(names).not.toContain("session_edit");

  const refused = await client.callTool({
    name: "session_create",
    arguments: { commandId: randomUUID(), title: "Should not exist" },
  });

  expect(refused.isError).toBe(true);
  expect(text(refused)).toMatch(/read-only/);

  const list = await client.callTool({ name: "session_list", arguments: {} });

  expect(JSON.parse(text(list))).toEqual([]);
});
