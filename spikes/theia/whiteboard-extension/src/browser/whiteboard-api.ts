import { injectable } from "@theia/core/shared/inversify";

import { WHITEBOARD_API_PATH } from "../common/whiteboard-paths";

/** Resolves a backend path against the page, so a sub-path deployment works. */
export function pageUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), document.baseURI).href;
}

/**
 * Same-origin access to the review API through the Theia backend proxy. The
 * canvas gets `serverUrl` from here and an empty token: the proxy adds the
 * real one.
 */
@injectable()
export class WhiteboardApi {
  readonly serverUrl = pageUrl(WHITEBOARD_API_PATH);

  request = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url, { ...init, credentials: "same-origin" });

  async json<T>(route: `/reviews-api${string}`): Promise<T> {
    const response = await this.request(`${this.serverUrl}${route}`);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status} ${body || response.statusText}`);
    }

    // SAFETY: callers name the review server's response type for their route;
    // the proxy forwards the server's JSON body unchanged.
    return (await response.json()) as T;
  }
}
