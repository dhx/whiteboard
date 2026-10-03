import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { AgentTokenStore, agentTokenFile } from "./agent-tokens";
import { runAgentTokensCli } from "./agent-tokens-cli";

let directory: string;

let file: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-tokens-"));
  file = path.join(directory, "data", "agent-tokens.json");
});

afterEach(() => rm(directory, { recursive: true, force: true }));

test("creates a token that verifies, and stores only its hash", async () => {
  const store = new AgentTokenStore(file);
  const { token, info } = await store.create("  laptop claude  ");

  assert.match(token, /^wbat_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  assert.equal(info.name, "laptop claude");
  assert.equal(info.scope, "write");
  assert.equal(info.revokedAt, null);

  const check = await store.verify(token);

  assert.equal(check.ok, true);
  assert.equal(check.ok && check.token.id, info.id);

  const stored = await readFile(file, "utf8");
  const secret = token.split("_").slice(2).join("_");

  assert.ok(!stored.includes(secret), "the secret must not be stored");
  assert.ok(stored.includes(info.id));
});

test("writes the token file privately and atomically", async () => {
  const store = new AgentTokenStore(file);

  await store.create("a");
  await store.create("b");

  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.equal((await store.list()).length, 2);
});

test("rejects malformed, unknown and forged tokens", async () => {
  const store = new AgentTokenStore(file);
  const { token, info } = await store.create("agent");
  const secret = token.slice(`wbat_${info.id}_`.length);
  const forged = `wbat_${info.id}_${secret.startsWith("A") ? "B" : "A"}${secret.slice(1)}`;

  for (const presented of [
    "",
    "Bearer x",
    "wbat_",
    `wbat_${info.id}`,
    `wbat_${info.id}_short`,
    `wbat_${info.id.toUpperCase()}_${secret}`,
    `${token}x`,
    ` ${token}`,
  ])
    assert.deepEqual(await store.verify(presented), {
      ok: false,
      reason: "malformed",
    });

  assert.deepEqual(await store.verify(forged), {
    ok: false,
    reason: "unknown",
  });
  assert.deepEqual(await store.verify(`wbat_00000000_${secret}`), {
    ok: false,
    reason: "unknown",
  });
});

test("a revocation applies to the next check, even from another process", async () => {
  const server = new AgentTokenStore(file);
  const { token, info } = await server.create("agent");

  assert.equal((await server.verify(token)).ok, true);

  // A second store over the same file stands in for the CLI's process.
  const cli = new AgentTokenStore(file);
  const revoked = await cli.revoke(info.id);

  assert.ok(revoked?.revokedAt);
  assert.deepEqual(await server.verify(token), {
    ok: false,
    reason: "revoked",
  });
  assert.equal(await cli.revoke("ffffffff"), undefined);
});

test("records last use, at most once a minute", async () => {
  let now = new Date("2026-10-03T10:00:00Z");
  const store = new AgentTokenStore(file, () => now);
  const { token, info } = await store.create("agent");

  assert.equal((await store.list())[0]?.lastUsedAt, null);

  await store.verify(token);
  await waitFor(async () => (await store.list())[0]?.lastUsedAt !== null);
  assert.equal((await store.list())[0]?.lastUsedAt, "2026-10-03T10:00:00.000Z");

  now = new Date("2026-10-03T10:00:30Z");
  await store.verify(token);
  now = new Date("2026-10-03T10:02:00Z");
  await store.verify(token);
  await waitFor(
    async () =>
      (await store.list())[0]?.lastUsedAt === "2026-10-03T10:02:00.000Z",
  );

  const usage = await readFile(file.replace(/\.json$/, ".usage.json"), "utf8");

  assert.deepEqual(JSON.parse(usage), {
    [info.id]: "2026-10-03T10:02:00.000Z",
  });
});

test("a damaged usage file does not lock agents out", async () => {
  const store = new AgentTokenStore(file);
  const { token } = await store.create("agent");

  await writeFile(file.replace(/\.json$/, ".usage.json"), "not json{");

  assert.equal((await store.verify(token)).ok, true);
  assert.equal((await store.list()).length, 1);
  await writeFile(file.replace(/\.json$/, ".usage.json"), '{"x": 1}');
  assert.equal((await store.verify(token)).ok, true);
});

test("rejects empty and control-character names", async () => {
  const store = new AgentTokenStore(file);

  await assert.rejects(store.create("   "));
  await assert.rejects(store.create("bad\nname"));
  await assert.rejects(store.create("x".repeat(81)));
});

test("keeps the token file next to the review state by default", () => {
  assert.equal(
    agentTokenFile({}, "/data/whiteboard"),
    "/data/agent-tokens.json",
  );
  assert.equal(
    agentTokenFile(
      { WHITEBOARD_AGENT_TOKENS_FILE: "/x/t.json" },
      "/data/whiteboard",
    ),
    "/x/t.json",
  );
});

async function waitFor(condition: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await condition()) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail("condition not met");
}

test("the container CLI lists and revokes, but cannot create", async () => {
  const env = { WHITEBOARD_AGENT_TOKENS_FILE: file };
  const { token, info } = await new AgentTokenStore(file).create("ops");
  let output = "";
  const write = (text: string) => (output += text);

  assert.equal(await runAgentTokensCli(["list"], env, write), 0);
  assert.match(output, new RegExp(`^${info.id}  active  write  `));
  assert.ok(!output.includes(token.slice(14)), "the CLI never prints a secret");

  output = "";
  assert.equal(await runAgentTokensCli(["revoke", info.id], env, write), 0);
  assert.equal((await new AgentTokenStore(file).verify(token)).ok, false);
  assert.equal(await runAgentTokensCli(["revoke", "ffffffff"], env, write), 1);
  assert.equal(await runAgentTokensCli(["create", "x"], env, write), 2);
  assert.equal(await runAgentTokensCli([], env, write), 2);
});
