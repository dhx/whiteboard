import type {
  ReviewCanvasBridge,
  ReviewDiffFileWire,
  ReviewDiffLayout,
  ReviewDiffSide,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewDisposable,
  ReviewInlineEditorFactory,
  ReviewInlineEditorHandle,
  ReviewInlineEditorRange,
  ReviewInlineEditorSpec,
  ReviewSourceView,
  ReviewTheme,
  ReviewVerbRequest,
  ReviewVerbResponse,
} from "@dev.fast/review-protocol" with { "resolution-mode": "import" };
import { DiffUris } from "@theia/core/lib/browser/diff-uris";
import { OpenerService, open } from "@theia/core/lib/browser/opener-service";
import { ThemeService } from "@theia/core/lib/browser/theming";
import { Emitter } from "@theia/core/lib/common/event";
import { MessageService } from "@theia/core/lib/common/message-service";
import { getThemeMode } from "@theia/core/lib/common/theme";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import type * as monaco from "@theia/monaco-editor-core";
import { EditorOption } from "@theia/monaco-editor-core/esm/vs/editor/common/config/editorOptions";
import { MonacoEditorProvider } from "@theia/monaco/lib/browser/monaco-editor-provider";
import type { SimpleMonacoEditor } from "@theia/monaco/lib/browser/simple-monaco-editor";

import {
  countMatchesInRanges,
  findPattern,
  hiddenLineRanges,
  visibleLineCount,
} from "../common/source-ranges";
import { WhiteboardApi } from "./whiteboard-api";
import {
  anchoredView,
  reviewSourceUri,
  sourceFileRoute,
  sourceQuery,
} from "./whiteboard-source";

const disposable = (dispose: () => void): ReviewDisposable => ({ dispose });

const CAPPED_LINES = 24;

/** What a review canvas tells its host as it renders. */
export interface WhiteboardReviewHost {
  /** The comparison the canvas is showing; sources resolve against it. */
  sourceView(): ReviewSourceView;
  openReview(reviewId: string): void;
}

/**
 * A read-only Theia Monaco editor for one authored source reference, showing
 * only the referenced lines. This is the piece Code-OSS provides natively
 * (`ReviewEmbeddedEditors`); here it is Theia's `SimpleMonacoEditor` backed by
 * the `whiteboard-source:` resource.
 */
class InlineSourceEditor implements ReviewInlineEditorHandle {
  private editor: SimpleMonacoEditor | undefined;
  private readonly host = document.createElement("div");
  private readonly heightChanged = new Emitter<number>();
  private readonly errors = new Emitter<string>();
  private collapsed = false;
  private disposed = false;
  private contentHeight = 0;
  private findMatches: monaco.IRange[] = [];
  private findDecorations: string[] = [];

  constructor(
    private readonly spec: ReviewInlineEditorSpec,
    uri: URI,
    provider: MonacoEditorProvider,
  ) {
    this.host.className = "whiteboard-inline-editor";
    spec.container.append(this.host);
    void this.mount(uri, provider);
  }

  private async mount(uri: URI, provider: MonacoEditorProvider) {
    try {
      const editor = await provider.createSimpleInline(uri, this.host, {
        readOnly: true,
      });

      if (this.disposed) {
        editor.dispose();

        return;
      }

      this.editor = editor;
      const control = editor.getControl();
      control.updateOptions({
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        lineNumbers: "on",
        folding: false,
        glyphMargin: false,
        renderLineHighlight: "none",
        scrollbar: { alwaysConsumeMouseWheel: false },
        overviewRulerLanes: 0,
      });

      const model = control.getModel();
      const lineCount = model?.getLineCount() ?? 0;
      const ranges = this.spec.ranges;
      control.setHiddenAreas(
        hiddenLineRanges(lineCount, ranges).map((range) => ({
          startLineNumber: range.startLine,
          startColumn: 1,
          endLineNumber: range.endLine,
          endColumn: 1,
        })),
      );

      const lines = visibleLineCount(lineCount, ranges);

      const shown =
        this.spec.heightMode === "capped"
          ? Math.min(lines, CAPPED_LINES)
          : lines;

      const lineHeight = control.getOption(EditorOption.lineHeight);
      this.contentHeight = Math.max(1, shown) * lineHeight + 8;
      this.layout();

      control.onDidFocusEditorWidget(() => this.spec.onDidFocus?.());
    } catch (error) {
      this.errors.fire(error instanceof Error ? error.message : String(error));
    }
  }

  private layout() {
    const height = this.collapsed ? 0 : this.contentHeight;
    this.host.style.height = `${height}px`;
    this.host.style.display = this.collapsed ? "none" : "block";
    this.editor?.getControl().layout();
    this.heightChanged.fire(height);
  }

  get height() {
    return this.collapsed ? 0 : this.contentHeight;
  }

  setActive() {}

  setCollapsed(collapsed: boolean) {
    this.collapsed = collapsed;
    this.layout();
  }

  onDidChangeHeight(listener: (height: number) => void) {
    return this.heightChanged.event(listener);
  }

  onDidError(listener: (message: string) => void) {
    return this.errors.event(listener);
  }

  async setFindQuery(query: {
    text: string;
    matchCase: boolean;
    wholeWord: boolean;
    isRegex: boolean;
  }) {
    const control = this.editor?.getControl();
    const model = control?.getModel();

    if (!control || !model || !findPattern(query)) {
      this.clearFind();

      return { matchCount: 0 };
    }

    const hidden = hiddenLineRanges(model.getLineCount(), this.spec.ranges);
    this.findMatches = model
      .findMatches(
        query.text,
        false,
        query.isRegex,
        query.matchCase,
        query.wholeWord ? " \t`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?" : null,
        false,
      )
      .map((match) => match.range)
      .filter(
        (range) =>
          !hidden.some(
            (area) =>
              range.startLineNumber >= area.startLine &&
              range.startLineNumber <= area.endLine,
          ),
      );
    this.findDecorations = control.deltaDecorations(
      this.findDecorations,
      this.findMatches.map((range) => ({
        range,
        options: {
          description: "whiteboard-find",
          inlineClassName: "findMatch",
        },
      })),
    );

    return { matchCount: this.findMatches.length };
  }

  revealFindMatch(index: number) {
    const range = this.findMatches[index];

    if (range) this.editor?.getControl().setSelection(range);
  }

  clearActiveFindMatch() {
    this.editor?.getControl().setSelection({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });
  }

  clearFind() {
    this.findMatches = [];
    this.findDecorations =
      this.editor?.getControl().deltaDecorations(this.findDecorations, []) ??
      [];
  }

  dispose() {
    this.disposed = true;
    this.editor?.dispose();
    this.host.remove();
    this.heightChanged.dispose();
    this.errors.dispose();
  }
}

/**
 * The changed-files list. Code-OSS renders a full multi-diff widget inside the
 * canvas; the spike lists the files and opens each one in Theia's own diff
 * editor, which is the gap a real port would close.
 */
class ChangedFilesView implements ReviewDiffViewHandle {
  private readonly root = document.createElement("div");
  private readonly errors = new Emitter<string>();
  private disposed = false;

  constructor(
    spec: ReviewDiffViewSpec,
    files: Promise<readonly ReviewDiffFileWire[]>,
    private readonly openFile: (file: ReviewDiffFileWire) => Promise<void>,
  ) {
    this.root.className = "whiteboard-changed-files";
    this.root.tabIndex = 0;
    spec.container.append(this.root);
    void this.render(spec, files);
  }

  private async render(
    spec: ReviewDiffViewSpec,
    files: Promise<readonly ReviewDiffFileWire[]>,
  ) {
    let list: readonly ReviewDiffFileWire[];

    try {
      list = await files;
    } catch (error) {
      this.errors.fire(error instanceof Error ? error.message : String(error));

      return;
    }

    if (this.disposed) return;

    const lens = spec.lens;

    const shown = lens
      ? list.filter((file) =>
          lens.ranges.some(
            (range) =>
              range.file === file.path || range.file === file.previousPath,
          ),
        )
      : list;

    for (const file of shown) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "whiteboard-changed-file";
      row.dataset.path = file.path;

      const name = document.createElement("span");
      name.textContent =
        file.previousPath && file.previousPath !== file.path
          ? `${file.previousPath} → ${file.path}`
          : file.path;

      const stats = document.createElement("span");
      stats.className = "whiteboard-changed-file-stats";
      stats.textContent = `${file.status} +${file.additions} −${file.deletions}`;

      row.append(name, stats);
      row.addEventListener("click", () => void this.openFile(file));
      this.root.append(row);
    }

    spec.document?.onDidChangeHeight(this.root.offsetHeight);
  }

  focus() {
    this.root.focus();
  }

  revealFile(path: string) {
    this.root
      .querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  onDidError(listener: (message: string) => void) {
    return this.errors.event(listener);
  }

  dispose() {
    this.disposed = true;
    this.root.remove();
    this.errors.dispose();
  }
}

@injectable()
export class WhiteboardBridgeFactory {
  @inject(WhiteboardApi) protected readonly api!: WhiteboardApi;
  @inject(MonacoEditorProvider)
  protected readonly editors!: MonacoEditorProvider;
  @inject(OpenerService) protected readonly openers!: OpenerService;
  @inject(ThemeService) protected readonly themes!: ThemeService;
  @inject(MessageService) protected readonly messages!: MessageService;

  private diffLayout: ReviewDiffLayout = "split";
  private readonly diffLayoutChanged = new Emitter<ReviewDiffLayout>();

  currentTheme(): ReviewTheme {
    return getThemeMode(this.themes.getCurrentTheme().type);
  }

  onDidChangeTheme(listener: (theme: ReviewTheme) => void): ReviewDisposable {
    return this.themes.onDidColorThemeChange((event) =>
      listener(getThemeMode(event.newTheme.type)),
    );
  }

  /** Opens one side of a review source in a Theia editor tab. */
  async openSource(
    view: ReviewSourceView,
    side: ReviewDiffSide,
    file: string,
    range?: Pick<ReviewInlineEditorRange, "startLine" | "endLine">,
  ) {
    await open(this.openers, reviewSourceUri(view, side, file), {
      mode: "reveal",
      selection: range && {
        start: { line: range.startLine - 1, character: 0 },
        end: { line: range.endLine - 1, character: 0 },
      },
    });
  }

  async openDiff(view: ReviewSourceView, file: ReviewDiffFileWire) {
    if (file.status === "added" || file.status === "deleted") {
      await this.openSource(
        view,
        file.status === "added" ? "head" : "base",
        file.status === "added" ? file.path : (file.previousPath ?? file.path),
      );

      return;
    }

    const base = reviewSourceUri(view, "base", file.previousPath ?? file.path);
    const head = reviewSourceUri(view, "head", file.path);
    await open(
      this.openers,
      DiffUris.encode(base, head, `${file.path} (review)`),
    );
  }

  private files(view: ReviewSourceView, commit?: string) {
    const query = sourceQuery(commit ? { ...view, commit } : view);

    return this.api.json<ReviewDiffFileWire[]>(
      `/reviews-api/${encodeURIComponent(view.reviewId)}/diff?${query}`,
    );
  }

  create(
    reviewId: string,
    wasmUrl: string,
    host: WhiteboardReviewHost,
  ): ReviewCanvasBridge {
    const inlineEditors: ReviewInlineEditorFactory = {
      create: (spec) =>
        new InlineSourceEditor(
          spec,
          reviewSourceUri(
            anchoredView(host.sourceView(), spec.pins),
            spec.side,
            spec.path,
          ),
          this.editors,
        ),
      find: async (spec, query) => {
        const { text } = await this.api.json<{ text: string }>(
          sourceFileRoute(
            anchoredView(host.sourceView(), spec.pins),
            spec.side,
            spec.path,
          ),
        );

        return { matchCount: countMatchesInRanges(text, spec.ranges, query) };
      },
    };

    const diffView: ReviewDiffViewFactory = {
      create: (spec) => {
        const view = host.sourceView();

        return new ChangedFilesView(
          spec,
          this.files(view, spec.scope?.commit),
          (file) => this.openDiff(view, file),
        );
      },
      files: (scope) => this.files(host.sourceView(), scope?.commit),
    };

    const post = async (
      request: ReviewVerbRequest,
    ): Promise<ReviewVerbResponse> => {
      switch (request.name) {
        case "reveal": {
          const view = anchoredView(host.sourceView(), request.args.pins);
          await this.openSource(
            view,
            request.args.side ?? "head",
            request.args.path,
            request.args,
          );

          return { ok: true };
        }

        case "openDiff": {
          const view = host.sourceView();
          const files = await this.files(view);
          const file = files.find((entry) => entry.path === request.args.path);

          if (!file) return { ok: false, error: "File is not in this diff." };

          await this.openDiff(view, file);

          return { ok: true };
        }

        case "openReview":
          host.openReview(request.args.reviewUuid);

          return { ok: true };
        case "openApiReview":
          host.openReview(request.args.reviewId);

          return { ok: true };
        case "showReviewView":
        case "focusCanvas":
        case "focusWindow":
          return { ok: true };
        default:
          return {
            ok: false,
            error: `${request.name} is not available in the Theia spike.`,
            code: "unsupported",
          };
      }
    };

    return {
      config: {
        serverUrl: this.api.serverUrl,
        reviewId,
        token: "",
        wasmUrl,
        appVersion: "theia-spike",
        theme: this.currentTheme(),
        host: "desktop",
      },
      inlineEditors,
      diffView,
      request: this.api.request,
      post,
      subscribe: () => disposable(() => {}),
      currentTheme: () => this.currentTheme(),
      onDidChangeTheme: (listener) => this.onDidChangeTheme(listener),
      currentDiffLayout: () => this.diffLayout,
      setDiffLayout: async (layout) => {
        this.diffLayout = layout;
        this.diffLayoutChanged.fire(layout);
      },
      onDidChangeDiffLayout: (listener) =>
        this.diffLayoutChanged.event(listener),
      notify: ({ kind, text }) =>
        void (kind === "error"
          ? this.messages.error(text)
          : this.messages.info(text)),
      ready: () => {},
      reportDiagnostic: (diagnostic) => {
        const log = diagnostic.level === "error" ? console.error : console.warn;
        log(
          `[Whiteboard canvas ${diagnostic.source}] ${diagnostic.message}`,
          diagnostic.stack ?? "",
        );
      },
    };
  }
}
