import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countMatchesInRanges,
  hiddenLineRanges,
  visibleLineCount,
} from "./source-ranges";

test("hides everything outside the authored ranges", () => {
  assert.deepEqual(
    hiddenLineRanges(20, [
      { startLine: 3, endLine: 5 },
      { startLine: 10, endLine: 12 },
    ]),
    [
      { startLine: 1, endLine: 2 },
      { startLine: 6, endLine: 9 },
      { startLine: 13, endLine: 20 },
    ],
  );
});

test("merges overlapping and adjacent ranges and clamps to the file", () => {
  assert.deepEqual(
    hiddenLineRanges(10, [
      { startLine: 4, endLine: 6 },
      { startLine: 5, endLine: 7 },
      { startLine: 8, endLine: 40 },
    ]),
    [{ startLine: 1, endLine: 3 }],
  );
  assert.equal(
    visibleLineCount(10, [
      { startLine: 4, endLine: 6 },
      { startLine: 5, endLine: 7 },
    ]),
    4,
  );
});

test("shows the whole file when no range is given", () => {
  assert.deepEqual(hiddenLineRanges(10, []), []);
  assert.equal(visibleLineCount(10, []), 10);
});

test("counts find matches only on visible lines", () => {
  const text = ["foo", "foo bar", "Foo", "foofoo"].join("\n");

  const query = {
    text: "foo",
    matchCase: false,
    wholeWord: false,
    isRegex: false,
  };

  assert.equal(
    countMatchesInRanges(text, [{ startLine: 2, endLine: 3 }], query),
    2,
  );
  assert.equal(
    countMatchesInRanges(text, [{ startLine: 1, endLine: 4 }], {
      ...query,
      matchCase: true,
      wholeWord: true,
    }),
    2,
  );
  assert.equal(
    countMatchesInRanges(text, [{ startLine: 1, endLine: 4 }], {
      ...query,
      text: "(",
      isRegex: true,
    }),
    0,
  );
});
