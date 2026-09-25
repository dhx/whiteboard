import type {
  ReviewDiffSide,
  ReviewSourcePins,
  ReviewSourceView,
} from "@dev.fast/review-protocol" with { "resolution-mode": "import" };
import { Resource, ResourceResolver } from "@theia/core/lib/common/resource";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";

import { WHITEBOARD_SOURCE_SCHEME } from "../common/whiteboard-paths";
import { WhiteboardApi } from "./whiteboard-api";

/** Mirrors `reviewSourceQuery` in `@dev.fast/review-protocol`. */
export function sourceQuery(view: ReviewSourceView) {
  const query = new URLSearchParams({ version: String(view.version) });

  if (view.commit) query.set("commit", view.commit);

  if (view.pins) {
    query.set("repositoryId", view.pins.repositoryId);
    query.set("head", view.pins.head);

    if (view.pins.base) query.set("base", view.pins.base);
  }

  return query;
}

/** Mirrors `reviewSourceAnchor`: a reference with its own pins reads there. */
export function anchoredView(
  view: ReviewSourceView,
  pins: ReviewSourcePins | undefined,
): ReviewSourceView {
  return pins ? { reviewId: view.reviewId, version: view.version, pins } : view;
}

export function sourceFileRoute(
  view: ReviewSourceView,
  side: ReviewDiffSide,
  file: string,
): `/reviews-api${string}` {
  const query = sourceQuery(view);
  query.set("side", side);
  query.set("file", file);

  return `/reviews-api/${encodeURIComponent(view.reviewId)}/file?${query}`;
}

/**
 * One file at one side of a review comparison. The file path is the URI path,
 * so Theia picks the language from the extension; the comparison rides in the
 * query.
 */
export function reviewSourceUri(
  view: ReviewSourceView,
  side: ReviewDiffSide,
  file: string,
): URI {
  const query = sourceQuery(view);
  query.set("reviewId", view.reviewId);
  query.set("side", side);

  return new URI(`${WHITEBOARD_SOURCE_SCHEME}:/${file}`).withQuery(
    query.toString(),
  );
}

class WhiteboardSourceResource implements Resource {
  readonly readOnly = true;

  constructor(
    readonly uri: URI,
    private readonly api: WhiteboardApi,
  ) {}

  async readContents(): Promise<string> {
    const query = new URLSearchParams(this.uri.query);
    const reviewId = query.get("reviewId");

    if (!reviewId) throw new Error(`No review in ${this.uri.toString()}`);

    query.delete("reviewId");
    query.set("file", this.uri.path.toString().replace(/^\//, ""));

    const body = await this.api.json<{ text: string }>(
      `/reviews-api/${encodeURIComponent(reviewId)}/file?${query}`,
    );

    return body.text;
  }

  dispose() {}
}

@injectable()
export class WhiteboardSourceResolver implements ResourceResolver {
  @inject(WhiteboardApi) protected readonly api!: WhiteboardApi;

  resolve(uri: URI): Resource {
    if (uri.scheme !== WHITEBOARD_SOURCE_SCHEME)
      throw new Error(`Not a Whiteboard source: ${uri.toString()}`);

    return new WhiteboardSourceResource(uri, this.api);
  }
}
