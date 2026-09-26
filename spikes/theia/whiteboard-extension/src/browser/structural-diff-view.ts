import { Emitter } from "@theia/core/lib/common/event";

import type {
  ReviewDiffLayout,
  ReviewDiffSide,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewDisposable,
} from "../common/review-protocol";
import {
  type StructuralItem,
  type StructuralLine,
  structuralItems,
} from "../common/structural-diff-model";
import type {
  StructuralDiffSession,
  StructuralFileState,
} from "../common/structural-diff-session";

export interface StructuralDiffViewHost {
  layout(): ReviewDiffLayout;
  setLayout(layout: ReviewDiffLayout): void;
  onDidChangeLayout(
    listener: (layout: ReviewDiffLayout) => void,
  ): ReviewDisposable;
  openSource(side: ReviewDiffSide, path: string, line: number): void;
  openDiff(file: StructuralFileState): void;
  /** Renders the plain changed-file list into `container` when diffr is unavailable. */
  fallback(container: HTMLElement): ReviewDiffViewHandle;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (className) node.className = className;

  if (text !== undefined) node.textContent = text;

  return node;
}

function button(label: string, title: string, action: () => void) {
  const node = element("button", "whiteboard-sd-action", label);

  node.type = "button";
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    action();
  });

  return node;
}

/**
 * diffr prefixes a pseudocode summary with a `// pseudocode` line for
 * terminals; the band has its own caption, so that line is dropped.
 */
function bandText(label: string) {
  const lines = label.split("\n");

  const body = /^(\/\/|#|--|;|%)\s*pseudocode$/.test(lines[0]?.trim() ?? "")
    ? lines.slice(1)
    : lines;

  return { title: body[0] ?? label, detail: body.slice(1).join("\n") };
}

/**
 * The Diff tab rendered from diffr's structural diff: rows aligned by syntax,
 * unchanged regions folded into labelled bands a reader can open, changed
 * tokens tinted, tests and docs hidden by default. Review Desktop draws the
 * same data inside its patched Monaco diff editor; stock Monaco (Theia's) has
 * no hooks for alignment or bands, so this view draws it directly.
 */
export class StructuralDiffView implements ReviewDiffViewHandle {
  private readonly root = element("div", "whiteboard-sd");
  private readonly toolbar = element("div", "whiteboard-sd-toolbar");
  private readonly status = element("span", "whiteboard-sd-status");
  private readonly layoutToggle = button("", "Switch diff layout", () =>
    this.host.setLayout(this.host.layout() === "split" ? "unified" : "split"),
  );
  private readonly list = element("div", "whiteboard-sd-files");
  private readonly sections = new Map<string, HTMLElement>();
  private readonly revealed = new Set<string>();
  private readonly closed = new Set<string>();
  private readonly errors = new Emitter<string>();
  private readonly disposables: ReviewDisposable[] = [];
  private fallback: ReviewDiffViewHandle | undefined;

  constructor(
    private readonly spec: ReviewDiffViewSpec,
    private readonly session: StructuralDiffSession,
    private readonly host: StructuralDiffViewHost,
  ) {
    this.root.tabIndex = 0;
    this.toolbar.append(this.status, this.layoutToggle);
    this.root.append(this.toolbar, this.list);
    spec.container.append(this.root);

    this.disposables.push(
      session.onDidChange((path) =>
        path === undefined ? this.renderAll() : this.renderFile(path),
      ),
      host.onDidChangeLayout(() => this.renderAll()),
    );

    if (spec.document) {
      const document = spec.document;

      const observer = new ResizeObserver(() =>
        document.onDidChangeHeight(this.root.offsetHeight),
      );

      observer.observe(this.root);
      this.disposables.push({ dispose: () => observer.disconnect() });
    }

    this.renderAll();
    void session.start();
  }

  private shownFiles(): StructuralFileState[] {
    const lens = this.spec.lens;

    if (!lens) return this.session.files;

    return this.session.files.filter((file) =>
      lens.ranges.some(
        (range) => range.file === file.path || range.file === file.previousPath,
      ),
    );
  }

  private renderStatus() {
    const files = this.shownFiles();
    const done = files.filter((file) => file.diff || file.error).length;

    if (this.session.error) {
      this.status.textContent = `Semantic diff unavailable: ${this.session.error}`;
      this.status.classList.add("whiteboard-sd-status--error");
    } else if (!this.session.complete) {
      this.status.textContent = files.length
        ? `Semantic diff by diffr · analyzing ${done} of ${files.length} files…`
        : "Semantic diff by diffr · starting…";
    } else {
      this.status.textContent = `Semantic diff by diffr · ${files.length} file${files.length === 1 ? "" : "s"}`;
    }
  }

  private renderAll() {
    this.renderStatus();
    this.layoutToggle.textContent =
      this.host.layout() === "split" ? "Unified" : "Side by side";

    // Nothing to show structurally: fall back to the plain file list.
    if (this.session.error && this.session.files.length === 0) {
      if (!this.fallback) {
        this.list.replaceChildren();
        this.fallback = this.host.fallback(this.list);
      }

      return;
    }

    this.list.replaceChildren();
    this.sections.clear();

    for (const file of this.shownFiles()) {
      const section = element("section", "whiteboard-sd-file");

      section.dataset.path = file.path;
      this.sections.set(file.path, section);
      this.list.append(section);
      this.fillSection(section, file);
    }
  }

  private renderFile(path: string) {
    this.renderStatus();

    const section = this.sections.get(path);
    const file = this.session.file(path);

    if (section && file) this.fillSection(section, file);
    else if (file && !section) this.renderAll();
  }

  private fillSection(section: HTMLElement, file: StructuralFileState) {
    const header = element("div", "whiteboard-sd-header");
    const open = !this.closed.has(file.path);

    const chevron = element(
      "span",
      `codicon codicon-chevron-${open ? "down" : "right"}`,
    );

    const name = element(
      "span",
      "whiteboard-sd-path",
      file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
    );

    header.append(
      chevron,
      name,
      element("span", "whiteboard-sd-badge", file.status),
    );

    for (const tag of file.tags)
      header.append(element("span", "whiteboard-sd-badge", tag));

    const diff = file.diff;

    if (diff?.type === "text") {
      const { visible, textual, fallback } = diff.stats;

      const counts = element(
        "span",
        "whiteboard-sd-counts",
        `+${visible.added} −${visible.removed}`,
      );

      counts.title = `Structural change +${visible.added} −${visible.removed}; text diff +${textual.added} −${textual.removed}`;
      header.append(counts);

      if (fallback) {
        const note = element(
          "span",
          "whiteboard-sd-badge whiteboard-sd-badge--warn",
          "text fallback",
        );

        note.title = fallback.message;
        header.append(note);
      }
    }

    const actions = element("span", "whiteboard-sd-actions");

    if (diff?.type === "text") {
      actions.append(
        button("Expand all", "Show every unchanged region", () =>
          this.session.setAllFolded(file.path, false),
        ),
        button("Reset folds", "Fold unchanged regions again", () =>
          this.session.setAllFolded(file.path, undefined),
        ),
      );
    }

    actions.append(
      button("Open diff", "Open this file in the diff editor", () =>
        this.host.openDiff(file),
      ),
    );
    header.append(actions);
    header.addEventListener("click", () => {
      if (open) this.closed.add(file.path);
      else this.closed.delete(file.path);

      this.fillSection(section, file);
    });

    section.replaceChildren(header);

    if (!open) return;

    if (file.error) {
      section.append(element("div", "whiteboard-sd-note", file.error));

      return;
    }

    if (!diff) {
      section.append(element("div", "whiteboard-sd-note", "Analyzing…"));

      return;
    }

    if (file.hiddenLabel && !this.revealed.has(file.path)) {
      const note = element(
        "div",
        "whiteboard-sd-note",
        `${file.hiddenLabel}. `,
      );

      note.append(
        button("Show", "Show this file's diff", () => {
          this.revealed.add(file.path);
          this.fillSection(section, file);
        }),
      );
      section.append(note);

      return;
    }

    if (diff.type === "binary") {
      section.append(element("div", "whiteboard-sd-note", "Binary file"));

      return;
    }

    if (file.annotationError)
      section.append(
        element(
          "div",
          "whiteboard-sd-note",
          `Summaries unavailable: ${file.annotationError}`,
        ),
      );

    section.append(
      this.table(file, structuralItems(diff, this.session.folded(file.path))),
    );
  }

  private table(file: StructuralFileState, items: StructuralItem[]) {
    const split = this.host.layout() === "split";

    const table = element(
      "div",
      `whiteboard-sd-table whiteboard-sd-table--${split ? "split" : "unified"}`,
    );

    for (const item of items) {
      if (item.kind === "band") {
        table.append(this.band(file, item));
        continue;
      }

      if (split) {
        table.append(
          this.gutter(file, "base", item.left),
          this.code(item.left, item.left ? item.change : "filler", "base"),
          this.gutter(file, "head", item.right),
          this.code(item.right, item.right ? item.change : "filler", "head"),
        );
        continue;
      }

      // Unified: a changed pair reads as the old line, then the new one.
      if (item.left && item.right && item.change === "unchanged") {
        table.append(
          this.gutter(file, "base", item.left),
          this.gutter(file, "head", item.right),
          this.code(item.right, "unchanged", "head"),
        );
        continue;
      }

      if (item.left)
        table.append(
          this.gutter(file, "base", item.left),
          this.gutter(file, "head", undefined),
          this.code(item.left, item.right ? "modified" : "removed", "base"),
        );

      if (item.right)
        table.append(
          this.gutter(file, "base", undefined),
          this.gutter(file, "head", item.right),
          this.code(item.right, item.left ? "modified" : "added", "head"),
        );
    }

    return table;
  }

  private band(
    file: StructuralFileState,
    item: Extract<StructuralItem, { kind: "band" }>,
  ) {
    const { title, detail } = bandText(item.label);
    const band = element("button", "whiteboard-sd-band");
    const count = Math.max(item.leftCount, item.rightCount);

    band.type = "button";
    band.title = "Show these lines";
    band.append(
      element("span", "codicon codicon-unfold"),
      element("span", "whiteboard-sd-band-title", title),
      element(
        "span",
        "whiteboard-sd-band-count",
        `${count} line${count === 1 ? "" : "s"}`,
      ),
    );

    if (detail)
      band.append(element("pre", "whiteboard-sd-band-detail", detail));

    band.addEventListener("click", () =>
      this.session.setFolded(file.path, item.foldStateIds, false),
    );

    return band;
  }

  private gutter(
    file: StructuralFileState,
    side: ReviewDiffSide,
    line: StructuralLine | undefined,
  ) {
    const cell = element(
      "span",
      "whiteboard-sd-gutter",
      line ? String(line.line + 1) : "",
    );

    if (line) {
      cell.dataset.side = side;
      cell.dataset.line = String(line.line + 1);
      cell.title = "Open in editor";
      cell.addEventListener("click", () =>
        this.host.openSource(
          side,
          side === "base" ? (file.previousPath ?? file.path) : file.path,
          line.line + 1,
        ),
      );
    }

    return cell;
  }

  private code(
    line: StructuralLine | undefined,
    change: string,
    side: ReviewDiffSide,
  ) {
    const cell = element(
      "span",
      `whiteboard-sd-code whiteboard-sd-code--${change} whiteboard-sd-code--${side}`,
    );

    if (!line) return cell;

    if (line.changed) cell.classList.add("whiteboard-sd-code--changed");

    let at = 0;

    for (const [start, end] of line.spans) {
      if (start > at) cell.append(line.text.slice(at, start));

      cell.append(
        element(
          "span",
          "whiteboard-sd-token",
          line.text.slice(Math.max(at, start), end),
        ),
      );
      at = Math.max(at, end);
    }

    cell.append(line.text.slice(at));

    return cell;
  }

  focus() {
    this.root.focus();
  }

  revealFile(path: string) {
    this.closed.delete(path);
    this.revealed.add(path);

    const file = this.session.file(path);
    const section = this.sections.get(path);

    if (file && section) {
      this.fillSection(section, file);
      section.scrollIntoView({ block: "start" });
    }
  }

  onDidError(listener: (message: string) => void) {
    return this.errors.event(listener);
  }

  dispose() {
    for (const disposable of this.disposables) disposable.dispose();

    this.fallback?.dispose();
    this.root.remove();
    this.errors.dispose();
  }
}
