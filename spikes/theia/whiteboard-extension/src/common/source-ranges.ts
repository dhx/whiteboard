export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * The lines an embedded editor hides so that only the authored ranges show.
 * Ranges are 1-based and inclusive, may overlap, and are clamped to the file.
 */
export function hiddenLineRanges(
  lineCount: number,
  visible: readonly LineRange[],
): LineRange[] {
  const shown = visible
    .flatMap((range) => {
      const startLine = Math.max(1, Math.min(range.startLine, range.endLine));

      const endLine = Math.min(
        lineCount,
        Math.max(range.startLine, range.endLine),
      );

      return startLine <= endLine ? [{ startLine, endLine }] : [];
    })
    .sort((a, b) => a.startLine - b.startLine);

  if (shown.length === 0) return [];

  const hidden: LineRange[] = [];
  let next = 1;

  for (const range of shown) {
    if (range.startLine > next)
      hidden.push({ startLine: next, endLine: range.startLine - 1 });
    next = Math.max(next, range.endLine + 1);
  }

  if (next <= lineCount) hidden.push({ startLine: next, endLine: lineCount });

  return hidden;
}

export function visibleLineCount(
  lineCount: number,
  visible: readonly LineRange[],
): number {
  return (
    lineCount -
    hiddenLineRanges(lineCount, visible).reduce(
      (sum, range) => sum + range.endLine - range.startLine + 1,
      0,
    )
  );
}

export interface FindQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

/** Builds the global RegExp the canvas find bar describes, or null if invalid. */
export function findPattern(query: FindQuery): RegExp | null {
  if (!query.text) return null;

  const source = query.isRegex
    ? query.text
    : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  try {
    return new RegExp(
      query.wholeWord ? `\\b(?:${source})\\b` : source,
      query.matchCase ? "gu" : "giu",
    );
  } catch {
    return null;
  }
}

/** Counts matches on the given lines only, the way the embedded editor shows them. */
export function countMatchesInRanges(
  text: string,
  ranges: readonly LineRange[],
  query: FindQuery,
): number {
  const pattern = findPattern(query);

  if (!pattern) return 0;

  const lines = text.split(/\r?\n/);
  const hidden = hiddenLineRanges(lines.length, ranges);
  let count = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (
      hidden.some(
        (range) => lineNumber >= range.startLine && lineNumber <= range.endLine,
      )
    )
      return;

    for (const match of line.matchAll(pattern)) if (match[0] !== "") count++;
  });

  return count;
}
