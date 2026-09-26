import {
  type StructuralDiff,
  type StructuralRegion,
  type StructuralSource,
  structuralRows,
} from "./review-protocol";

export type StructuralTextDiff = Extract<StructuralDiff, { type: "text" }>;

/** One source line of one side; `line` is zero-based like the wire. */
export interface StructuralLine {
  line: number;
  text: string;
  /** Inside diffr's structural change coverage for this side. */
  changed: boolean;
  /** Changed tokens as UTF-16 `[start, end)` columns into `text`. */
  spans: [number, number][];
}

export type StructuralRowChange =
  | "unchanged"
  | "added"
  | "removed"
  | "modified";

export type StructuralItem =
  | {
      kind: "row";
      left?: StructuralLine;
      right?: StructuralLine;
      change: StructuralRowChange;
    }
  | {
      kind: "band";
      label: string;
      leftCount: number;
      rightCount: number;
      /** Opening the band opens these fold states. */
      foldStateIds: number[];
    };

/** Whether a region is folded: the reader's choice, else diffr's default. */
export type FoldState = (region: StructuralRegion) => boolean;

export const defaultFoldState: FoldState = (region) =>
  region.visibility?.collapsed === true;

/** The zero-based, half-open lines a region covers; an end at column 0 stops before its line. */
function regionLines(region: StructuralRegion) {
  return {
    start: region.start.line,
    end: region.end.column === 0 ? region.end.line : region.end.line + 1,
  };
}

/** diffr columns are UTF-8 bytes; the DOM wants UTF-16 code units. */
export function utf16Column(text: string, byteColumn: number): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  let units = 0;

  for (const character of text) {
    if (bytes >= byteColumn) break;

    bytes += encoder.encode(character).length;
    units += character.length;
  }

  return units;
}

function sourceLines(source: StructuralSource | undefined): string[] {
  return source ? source.text.replace(/\r\n/g, "\n").split("\n") : [];
}

/** Outermost folded region per hidden line; a folded region hides its descendants. */
function hiddenLines(
  regions: readonly StructuralRegion[] | undefined,
  folded: FoldState,
): Map<number, StructuralRegion> {
  const hidden = new Map<number, StructuralRegion>();

  const walk = (region: StructuralRegion) => {
    const lines = regionLines(region);

    if (lines.end > lines.start && folded(region)) {
      for (let line = lines.start; line < lines.end; line++)
        hidden.set(line, region);

      return;
    }

    if (region.kind === "fold") region.children.forEach(walk);
  };

  regions?.forEach(walk);

  return hidden;
}

function changedSpans(source: StructuralSource | undefined, lines: string[]) {
  const spans = new Map<number, [number, number][]>();

  const walk = (region: StructuralRegion) => {
    if (region.kind === "fold") {
      region.children.forEach(walk);

      return;
    }

    for (const span of region.changed ?? []) {
      const text = lines[span.line] ?? "";
      const group = spans.get(span.line) ?? [];

      group.push([
        utf16Column(text, span.start_column),
        utf16Column(text, span.end_column),
      ]);
      spans.set(span.line, group);
    }
  };

  source?.regions?.forEach(walk);

  for (const group of spans.values()) group.sort((a, b) => a[0] - b[0]);

  return spans;
}

function changedLines(ranges: readonly (readonly [number, number])[]) {
  const lines = new Set<number>();

  for (const [start, end] of ranges)
    for (let line = start; line < end; line++) lines.add(line);

  return lines;
}

function hiddenLabel(count: number) {
  return `${count} hidden line${count === 1 ? "" : "s"}`;
}

/**
 * Lays one file's structural diff out for display: diffr's aligned rows, with
 * every run of rows hidden by a folded region replaced by one labelled band.
 * The row table is `structuralRows` from the protocol package, the same
 * alignment Review Desktop feeds its diff editor.
 */
export function structuralItems(
  diff: StructuralTextDiff,
  folded: FoldState = defaultFoldState,
): StructuralItem[] {
  const left = sourceLines(diff.lhs);
  const right = sourceLines(diff.rhs);
  const hiddenLeft = hiddenLines(diff.lhs?.regions, folded);
  const hiddenRight = hiddenLines(diff.rhs?.regions, folded);
  const spansLeft = changedSpans(diff.lhs, left);
  const spansRight = changedSpans(diff.rhs, right);
  const changedLeft = changedLines(diff.structural_changes.base);
  const changedRight = changedLines(diff.structural_changes.head);

  const line = (
    number: number | null,
    text: string[],
    changed: Set<number>,
    spans: Map<number, [number, number][]>,
  ): StructuralLine | undefined =>
    number === null
      ? undefined
      : {
          line: number,
          text: text[number] ?? "",
          changed: changed.has(number),
          spans: spans.get(number) ?? [],
        };

  const items: StructuralItem[] = [];

  let band:
    | {
        item: Extract<StructuralItem, { kind: "band" }>;
        left?: StructuralRegion;
        right?: StructuralRegion;
      }
    | undefined;

  for (const [l, r] of structuralRows(diff)) {
    const regionLeft = l === null ? undefined : hiddenLeft.get(l);
    const regionRight = r === null ? undefined : hiddenRight.get(r);

    const hidden =
      (l === null || regionLeft !== undefined) &&
      (r === null || regionRight !== undefined);

    if (!hidden) {
      band = undefined;

      const change: StructuralRowChange =
        l === null
          ? "added"
          : r === null
            ? "removed"
            : changedLeft.has(l) || changedRight.has(r)
              ? "modified"
              : "unchanged";

      items.push({
        kind: "row",
        left: line(l, left, changedLeft, spansLeft),
        right: line(r, right, changedRight, spansRight),
        change,
      });
      continue;
    }

    // A new region on either side starts a new band.
    const continues =
      band !== undefined &&
      (regionLeft === undefined ||
        band.left === undefined ||
        band.left === regionLeft) &&
      (regionRight === undefined ||
        band.right === undefined ||
        band.right === regionRight);

    if (!band || !continues) {
      band = {
        item: {
          kind: "band",
          label: "",
          leftCount: 0,
          rightCount: 0,
          foldStateIds: [],
        },
      };
      items.push(band.item);
    }

    band.left ??= regionLeft;
    band.right ??= regionRight;

    if (l !== null) band.item.leftCount++;

    if (r !== null) band.item.rightCount++;

    band.item.foldStateIds = [
      ...new Set(
        [band.right?.fold_state_id, band.left?.fold_state_id].filter(
          (id): id is number => id !== undefined,
        ),
      ),
    ];
    // Head's label first, as Review Desktop does, then base's.
    band.item.label =
      band.right?.visibility?.label ||
      band.left?.visibility?.label ||
      hiddenLabel(Math.max(band.item.leftCount, band.item.rightCount));
  }

  return items;
}

/** Every region of a file, keyed by its region id, for applying annotation labels. */
export function regionsById(diff: StructuralTextDiff) {
  const regions = new Map<number, StructuralRegion>();

  const walk = (region: StructuralRegion) => {
    regions.set(region.id, region);

    if (region.kind === "fold") region.children.forEach(walk);
  };

  diff.lhs?.regions?.forEach(walk);
  diff.rhs?.regions?.forEach(walk);

  return regions;
}
