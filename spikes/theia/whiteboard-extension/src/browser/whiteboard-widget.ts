import {
  BaseWidget,
  type Message,
} from "@theia/core/lib/browser/widgets/widget";
import { MessageService } from "@theia/core/lib/common/message-service";
import {
  inject,
  injectable,
  postConstruct,
} from "@theia/core/shared/inversify";

import type {
  ReviewApiSummary,
  ReviewCanvasContent,
  ReviewCanvasHandle,
  ReviewSourceView,
} from "../common/review-protocol";
import { WhiteboardApi } from "./whiteboard-api";
import { WhiteboardBridgeFactory } from "./whiteboard-bridge";
import { WhiteboardCanvasLoader } from "./whiteboard-canvas-loader";

export const WhiteboardWidgetOptions = Symbol("WhiteboardWidgetOptions");

export interface WhiteboardWidgetOptions {
  /** Absent for Home, the list of reviews. */
  reviewId?: string;
}

export const WhiteboardOpener = Symbol("WhiteboardOpener");

export interface WhiteboardOpener {
  openReview(reviewId: string): Promise<void>;
}

const HOME_REFRESH_MS = 5_000;

export function whiteboardWidgetId(reviewId?: string) {
  return reviewId ? `whiteboard:${reviewId}` : "whiteboard:home";
}

/**
 * Hosts one mount of the Whiteboard canvas: Home, or one review. The canvas
 * is the unchanged `mountReviewCanvas` from `packages/review/app`.
 */
@injectable()
export class WhiteboardWidget extends BaseWidget {
  static readonly FACTORY_ID = "whiteboard";

  @inject(WhiteboardWidgetOptions)
  protected readonly options!: WhiteboardWidgetOptions;
  @inject(WhiteboardCanvasLoader)
  protected readonly loader!: WhiteboardCanvasLoader;
  @inject(WhiteboardBridgeFactory)
  protected readonly bridges!: WhiteboardBridgeFactory;
  @inject(WhiteboardApi) protected readonly api!: WhiteboardApi;
  @inject(WhiteboardOpener) protected readonly opener!: WhiteboardOpener;
  @inject(MessageService) protected readonly messages!: MessageService;

  // The canvas styles its root with `min-height: 100%`, which resolves against
  // the dock panel rather than this widget's slot when mounted on the widget
  // node itself; an absolutely positioned host keeps it inside the slot.
  private readonly host = document.createElement("div");
  private canvas: ReviewCanvasHandle | undefined;
  private mounting: Promise<void> | undefined;
  private homeTimer: ReturnType<typeof setInterval> | undefined;
  private homeSnapshot = "";
  private sourceView: ReviewSourceView | undefined;

  @postConstruct()
  protected init() {
    const { reviewId } = this.options;
    this.id = whiteboardWidgetId(reviewId);
    this.title.label = reviewId ? "Review" : "Whiteboard";
    this.title.caption = reviewId ?? "Whiteboard reviews";
    this.title.iconClass = "codicon codicon-preview";
    this.title.closable = true;
    this.addClass("whiteboard-widget");
    this.node.tabIndex = 0;
    this.host.className = "whiteboard-canvas-host";
    this.node.append(this.host);
    this.toDispose.push({
      dispose: () => {
        if (this.homeTimer) clearInterval(this.homeTimer);
        this.canvas?.dispose();
        this.canvas = undefined;
      },
    });
  }

  protected override onAfterAttach(message: Message) {
    super.onAfterAttach(message);
    this.mounting ??= this.mount().catch((error) => {
      this.mounting = undefined;
      this.host.textContent = `Whiteboard canvas failed to load: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  protected override onActivateRequest(message: Message) {
    super.onActivateRequest(message);

    this.canvas?.focus();

    // Home has nothing focusable until its list renders; Theia needs focus
    // inside the widget to treat it as active.
    if (!this.node.contains(document.activeElement)) this.node.focus();
  }

  private async mount() {
    const assets = await this.loader.load();

    const content = this.options.reviewId
      ? this.reviewContent(this.options.reviewId, assets.reviewWasmUrl)
      : await this.homeContent();

    if (this.isDisposed) return;

    this.canvas = assets.mountReviewCanvas(this.host, content);

    if (!this.options.reviewId) {
      this.homeTimer = setInterval(
        () => void this.refreshHome(),
        HOME_REFRESH_MS,
      );
    }
  }

  private reviewContent(
    reviewId: string,
    wasmUrl: string,
  ): ReviewCanvasContent {
    const initialView: ReviewSourceView = { reviewId, version: 0 };

    return {
      kind: "api",
      reviewId,
      structuralDiffEnabled: true,
      softwareMapEnabled: true,
      bridge: this.bridges.create(reviewId, wasmUrl, {
        sourceView: () => this.sourceView ?? initialView,
        openReview: (id) => void this.opener.openReview(id),
        register: (disposable) => this.toDispose.push(disposable),
      }),
      setTitle: (title) => {
        this.title.label = title;
      },
      setSourceView: (_selection, view) => {
        this.sourceView = view;
      },
      openSource: (source, range) =>
        this.bridges.openSource(source.view, source.side, source.file, range),
    };
  }

  private async homeContent(
    reviews?: ReviewApiSummary[],
  ): Promise<ReviewCanvasContent> {
    reviews ??= await this.api.json<ReviewApiSummary[]>("/reviews-api");
    this.homeSnapshot = JSON.stringify(reviews);

    return {
      kind: "home",
      reviews,
      openReview: (id) => void this.opener.openReview(id),
      openTutorial: () =>
        void this.messages.info(
          "The tutorial needs the desktop host; it is not part of the Theia spike.",
        ),
    };
  }

  private async refreshHome() {
    if (!this.canvas || !this.isVisible) return;

    try {
      const reviews = await this.api.json<ReviewApiSummary[]>("/reviews-api");

      if (JSON.stringify(reviews) === this.homeSnapshot) return;

      this.canvas?.update(await this.homeContent(reviews));
    } catch (error) {
      console.warn("[whiteboard] could not refresh reviews", error);
    }
  }
}
