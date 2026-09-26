import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { StructuralDiffSchema, type StructuralRegion } from "./review-protocol";
import {
  type StructuralTextDiff,
  structuralItems,
  utf16Column,
} from "./structural-diff-model";

function leaf(
  id: number,
  alignment: number,
  start: number,
  end: number,
  extra: Partial<Extract<StructuralRegion, { kind: "leaf" }>> = {},
): StructuralRegion {
  return {
    id,
    fold_state_id: id,
    kind: "leaf",
    alignment_id: alignment,
    start: { line: start, column: 0 },
    end: { line: end, column: 0 },
    ...extra,
  };
}

const folded = { collapsed: true, label: "2 unchanged lines" };

// Base "a b c d", head inserts "X" after "b".
function diff(
  options: { foldTop?: boolean; foldBottom?: boolean } = {},
): StructuralTextDiff {
  return {
    type: "text",
    stats: {
      textual: { added: 1, removed: 0 },
      visible: { added: 1, removed: 0 },
    },
    structural_changes: { base: [], head: [[2, 3]] },
    lhs: {
      text: "a\nb\nc\nd\n",
      regions: [
        leaf(1, 1, 0, 2, options.foldTop ? { visibility: folded } : {}),
        leaf(2, 2, 2, 4, options.foldBottom ? { visibility: folded } : {}),
      ],
    },
    rhs: {
      text: "a\nb\nX\nc\nd\n",
      regions: [
        leaf(11, 1, 0, 2, options.foldTop ? { visibility: folded } : {}),
        leaf(12, 3, 2, 3, {
          changed: [{ line: 2, start_column: 0, end_column: 1 }],
        }),
        leaf(13, 2, 3, 5, options.foldBottom ? { visibility: folded } : {}),
      ],
    },
  };
}

const rowSummary = (items: ReturnType<typeof structuralItems>) =>
  items.map((item) =>
    item.kind === "band"
      ? `band ${item.leftCount}/${item.rightCount} ${item.label}`
      : `${item.change} ${item.left?.line ?? "-"}:${item.right?.line ?? "-"}`,
  );

test("aligns both sides by diffr's leaves and marks the inserted line", () => {
  const items = structuralItems(diff());

  assert.deepEqual(rowSummary(items), [
    "unchanged 0:0",
    "unchanged 1:1",
    "added -:2",
    "unchanged 2:3",
    "unchanged 3:4",
    "unchanged 4:5",
  ]);

  const added = items[2];

  assert.equal(added?.kind === "row" && added.right?.text, "X");
  assert.deepEqual(added?.kind === "row" && added.right?.spans, [[0, 1]]);
});

test("replaces folded regions with one labelled band per region", () => {
  const items = structuralItems(diff({ foldTop: true, foldBottom: true }));

  assert.deepEqual(rowSummary(items), [
    "band 2/2 2 unchanged lines",
    "added -:2",
    "band 2/2 2 unchanged lines",
    "unchanged 4:5",
  ]);

  const band = items[0];

  assert.deepEqual(band?.kind === "band" && band.foldStateIds, [11, 1]);
});

test("a reader's choice overrides diffr's default fold", () => {
  const items = structuralItems(diff({ foldTop: true }), () => false);

  assert.equal(
    items.some((item) => item.kind === "band"),
    false,
  );
});

test("converts UTF-8 byte columns to UTF-16", () => {
  assert.equal(utf16Column("é=1", 2), 1);
  assert.equal(utf16Column("😀x", 4), 2);
  assert.equal(utf16Column("abc", 10), 3);
});

test("accounts for every line of a real diffr result exactly once", () => {
  // diffr 0.1.3 on packages/review/src/connect-prompts.ts, cc43318~1..cc43318.
  const fixture = path.join(
    __dirname,
    "../../src/common/fixtures/connect-prompts.diffr.json",
  );

  const real = StructuralDiffSchema.parse(
    JSON.parse(readFileSync(fixture, "utf8")),
  );

  assert.equal(real.type, "text");

  if (real.type !== "text") return;

  for (const folds of [undefined, () => false]) {
    const items = structuralItems(real, folds);
    let left = 0;
    let right = 0;

    for (const item of items) {
      if (item.kind === "band") {
        left += item.leftCount;
        right += item.rightCount;
        continue;
      }

      if (item.left) assert.equal(item.left.line, left++);

      if (item.right) assert.equal(item.right.line, right++);
    }

    assert.equal(left, real.lhs?.text.split("\n").length);
    assert.equal(right, real.rhs?.text.split("\n").length);
  }

  const bands = structuralItems(real).filter((item) => item.kind === "band");

  assert.ok(bands.length > 0);
  assert.ok(bands.every((band) => band.label.endsWith("unchanged lines")));
});
