import { Resource, ResourceResolver } from "@theia/core/lib/common/resource";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";

import {
  type ReviewDiffSide,
  type ReviewSourceView,
  reviewSourceAnchor,
  reviewSourceQuery,
} from "../common/review-protocol";
import { WHITEBOARD_SOURCE_SCHEME } from "../common/whiteboard-paths";
import { WhiteboardApi } from "./whiteboard-api";

/** The review server's source query for a comparison, as URL parameters. */
export function sourceQuery(view: ReviewSourceView) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(reviewSourceQuery(view)))
    if (value !== undefined) query.set(key, String(value));

  return query;
}

/** A reference with its own pins reads there, not at the review's. */
export const anchoredView = reviewSourceAnchor;

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
