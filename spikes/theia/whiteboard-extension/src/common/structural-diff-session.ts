import {
  type ReviewStructuralDiffEvent,
  STRUCTURAL_DIFF_WIRE_VERSION,
  type StructuralDiff,
  type StructuralFileRef,
  type StructuralFileStatus,
  type StructuralPairing,
  decodeReviewStructuralDiffEvent,
} from "./review-protocol";
import {
  type FoldState,
  defaultFoldState,
  regionsById,
} from "./structural-diff-model";

export interface StructuralFileState {
  path: string;
  previousPath?: string;
  status: StructuralFileStatus;
  tags: readonly string[];
  diff?: StructuralDiff;
  error?: string;
  /** Set when diffr hides the whole file by default (tests, docs), with its reason. */
  hiddenLabel?: string;
  annotationError?: string;
}

export type StructuralStream = (
  signal: AbortSignal,
) => AsyncIterable<ReviewStructuralDiffEvent>;

/** Review keys a file by its head path, or its base path for a deletion. */
function filePath(file: StructuralPairing<StructuralFileRef>): string {
  return file.rhs?.path ?? file.lhs!.path;
}

/** Splits an NDJSON response body into validated diffr records. */
export async function* readStructuralStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ReviewStructuralDiffEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const chunk = await reader.read();

      buffer += decoder.decode(chunk.value, { stream: !chunk.done });

      const lines = buffer.split("\n");

      buffer = chunk.done ? "" : lines.pop()!;

      for (const line of lines)
        if (line.trim()) yield decodeReviewStructuralDiffEvent(line);

      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * One structural comparison of a review, streamed from the review server's
 * `/structural-diff` route (which runs diffr). Views observe it and change
 * fold state; the fold state outlives them, like Review Desktop's session.
 */
export class StructuralDiffSession {
  readonly files: StructuralFileState[] = [];
  error: string | undefined;
  complete = false;

  private readonly byPath = new Map<string, StructuralFileState>();
  private readonly folds = new Map<string, boolean>();
  private readonly listeners = new Set<(path?: string) => void>();
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;

  constructor(private readonly stream: StructuralStream) {}

  start(): Promise<void> {
    this.task ??= this.consume();

    return this.task;
  }

  file(path: string): StructuralFileState | undefined {
    return this.byPath.get(path);
  }

  /** Listens for changes to one file (its path) or to the session (no path). */
  onDidChange(listener: (path?: string) => void) {
    this.listeners.add(listener);

    return { dispose: () => this.listeners.delete(listener) };
  }

  folded(path: string): FoldState {
    return (region) =>
      this.folds.get(`${path}:${region.fold_state_id}`) ??
      defaultFoldState(region);
  }

  setFolded(path: string, foldStateIds: readonly number[], folded: boolean) {
    for (const id of foldStateIds) this.folds.set(`${path}:${id}`, folded);
    this.notify(path);
  }

  /** Every region of the file open (`false`) or back to diffr's defaults (`undefined`). */
  setAllFolded(path: string, folded: false | undefined) {
    const diff = this.byPath.get(path)?.diff;

    for (const key of [...this.folds.keys()])
      if (key.startsWith(`${path}:`)) this.folds.delete(key);

    if (folded === false && diff?.type === "text")
      for (const region of regionsById(diff).values())
        this.folds.set(`${path}:${region.fold_state_id}`, false);

    this.notify(path);
  }

  dispose() {
    this.abort.abort();
    this.listeners.clear();
  }

  private notify(path?: string) {
    for (const listener of this.listeners) listener(path);
  }

  private async consume() {
    let started = false;

    try {
      for await (const event of this.stream(this.abort.signal)) {
        if (this.complete)
          throw new Error("diffr emitted data after completion.");

        if (!started) {
          if (
            event.type !== "start" ||
            event.version !== STRUCTURAL_DIFF_WIRE_VERSION
          )
            throw new Error(
              event.type === "error"
                ? event.message
                : "Unsupported diffr stream protocol.",
            );

          started = true;
          this.acceptManifest(event);
          this.notify();
          continue;
        }

        this.apply(event);
      }

      if (!this.complete)
        throw new Error("diffr stream ended before completion.");
    } catch (error) {
      if (this.abort.signal.aborted) return;

      this.error = error instanceof Error ? error.message : String(error);
      this.complete = true;
      this.notify();
    }
  }

  private acceptManifest(
    event: Extract<ReviewStructuralDiffEvent, { type: "start" }>,
  ) {
    for (const change of event.files) {
      const state: StructuralFileState = {
        path: filePath(change.file),
        previousPath:
          change.file.lhs && change.file.lhs.path !== change.file.rhs?.path
            ? change.file.lhs.path
            : undefined,
        status: change.status,
        tags: change.tags ?? [],
      };

      if (this.byPath.has(state.path))
        throw new Error(`diffr repeated ${state.path} in its manifest.`);

      this.files.push(state);
      this.byPath.set(state.path, state);
    }
  }

  private apply(event: ReviewStructuralDiffEvent) {
    switch (event.type) {
      case "file": {
        const state = this.known(filePath(event.file));

        if (state.diff || state.error)
          throw new Error(`diffr repeated a result for ${state.path}.`);

        if (event.error) state.error = event.error.message;
        else state.diff = event.diff;

        if (event.visibility?.collapsed)
          state.hiddenLabel = event.visibility.label || "Hidden by default";

        this.notify(state.path);

        return;
      }

      case "annotations": {
        const state = this.known(filePath(event.file));

        if (state.diff?.type !== "text")
          throw new Error(`Annotations precede a text result: ${state.path}`);

        const regions = regionsById(state.diff);

        // Validate the batch before applying any of it.
        for (const annotation of event.annotations)
          if (!regions.has(annotation.region_id))
            throw new Error(
              `Unknown annotation region: ${annotation.region_id}`,
            );

        for (const annotation of event.annotations) {
          const region = regions.get(annotation.region_id)!;

          region.visibility = { ...region.visibility, label: annotation.label };
        }

        state.annotationError = event.error?.message;
        this.notify(state.path);

        return;
      }

      case "complete":
        for (const state of this.files)
          if (!state.diff && !state.error) {
            state.error = "diffr did not supply a result for this file.";
            this.notify(state.path);
          }

        this.complete = true;

        if (event.aborted)
          this.error = `diffr stopped early: ${event.aborted.message}`;

        this.notify();

        return;

      case "error":
        throw new Error(event.message);

      case "start":
        throw new Error("diffr started a second comparison.");
    }
  }

  private known(path: string): StructuralFileState {
    const state = this.byPath.get(path);

    if (!state)
      throw new Error(`diffr sent ${path}, which is not in its manifest.`);

    return state;
  }
}
