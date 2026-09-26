import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  type ReviewStructuralDiffEvent,
  STRUCTURAL_DIFF_WIRE_VERSION,
  StructuralDiffSchema,
} from "./review-protocol";
import { structuralItems } from "./structural-diff-model";
import {
  StructuralDiffSession,
  readStructuralStream,
} from "./structural-diff-session";

const file = "packages/review/src/connect-prompts.ts";

const other = "packages/review/src/connect-prompts.test.ts";

const ref = (filePath: string) => ({
  path: filePath,
  oid: "0",
  mode: "100644",
});

function textDiff() {
  const parsed = StructuralDiffSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(
          __dirname,
          "../../src/common/fixtures/connect-prompts.diffr.json",
        ),
        "utf8",
      ),
    ),
  );

  if (parsed.type !== "text") throw new Error("The fixture is a text diff.");

  return parsed;
}

const diff = textDiff();

function start(): Extract<ReviewStructuralDiffEvent, { type: "start" }> {
  return {
    type: "start",
    version: STRUCTURAL_DIFF_WIRE_VERSION,
    lhs: { type: "revision", rev: "base" },
    rhs: { type: "revision", rev: "head" },
    files: [
      { file: { lhs: ref(file), rhs: ref(file) }, status: "modified" },
      {
        file: { lhs: ref(other), rhs: ref(other) },
        status: "modified",
        tags: ["test"],
      },
    ],
  };
}

async function run(events: ReviewStructuralDiffEvent[]) {
  const session = new StructuralDiffSession(async function* () {
    yield* events;
  });

  await session.start();

  return session;
}

test("applies diffr's summary labels to the bands they name", async () => {
  const text = structuredClone(diff);
  const band = structuralItems(text).find((item) => item.kind === "band");

  assert.ok(band?.kind === "band");

  // The first band hides a region on each side; the head region labels it.
  const labelled = text.rhs?.regions?.[0];

  assert.ok(labelled);

  const session = await run([
    start(),
    { type: "file", file: { lhs: ref(file), rhs: ref(file) }, diff: text },
    {
      type: "annotations",
      file: { lhs: ref(file), rhs: ref(file) },
      annotations: [
        { region_id: labelled.id, label: "imports and launch config" },
      ],
    },
    { type: "complete", succeeded: 1, failed: 0 },
  ]);

  const result = session.file(file)?.diff;

  assert.equal(session.error, undefined);
  assert.ok(result?.type === "text");

  const first = structuralItems(result).find((item) => item.kind === "band");

  assert.equal(
    first?.kind === "band" && first.label,
    "imports and launch config",
  );
});

test("reports files diffr never answered for once it completes", async () => {
  const session = await run([
    start(),
    { type: "file", file: { lhs: ref(file), rhs: ref(file) }, diff },
    { type: "complete", succeeded: 1, failed: 0 },
  ]);

  assert.equal(session.complete, true);
  assert.equal(
    session.file(other)?.error,
    "diffr did not supply a result for this file.",
  );
});

test("keeps the reader's folds per file", async () => {
  const session = await run([
    start(),
    { type: "file", file: { lhs: ref(file), rhs: ref(file) }, diff },
    { type: "complete", succeeded: 1, failed: 0 },
  ]);

  const text = session.file(file)?.diff;

  assert.ok(text?.type === "text");

  const bands = () =>
    structuralItems(text, session.folded(file)).filter(
      (item) => item.kind === "band",
    );

  const before = bands();
  const first = before[0];

  assert.ok(first?.kind === "band");
  session.setFolded(file, first.foldStateIds, false);
  assert.equal(bands().length, before.length - 1);
  session.setAllFolded(file, false);
  assert.equal(bands().length, 0);
  session.setAllFolded(file, undefined);
  assert.equal(bands().length, before.length);
});

test("surfaces a server error and an unsupported protocol", async () => {
  const failed = await run([{ type: "error", message: "Cannot find diffr" }]);

  assert.equal(failed.error, "Cannot find diffr");

  const old = await run([{ ...start(), version: 3 }]);

  assert.equal(old.error, "Unsupported diffr stream protocol.");

  const truncated = await run([start()]);

  assert.equal(truncated.error, "diffr stream ended before completion.");
});

test("splits an NDJSON body across chunk boundaries", async () => {
  const lines = [
    JSON.stringify({ type: "error", message: "one" }),
    JSON.stringify({ type: "error", message: "two" }),
  ].join("\n");

  const bytes = new TextEncoder().encode(lines);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7, 40));
      controller.enqueue(bytes.slice(40));
      controller.close();
    },
  });

  const messages: string[] = [];

  for await (const event of readStructuralStream(body))
    if (event.type === "error") messages.push(event.message);

  assert.deepEqual(messages, ["one", "two"]);
});
