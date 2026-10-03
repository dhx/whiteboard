import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { request as httpRequest } from "node:http";

export interface ReviewServerConnection {
  url: string;
  token: string;
}

// The canvas builds every URL as `${serverUrl}/reviews-api/...`; nothing else
// on the review server is reachable through Theia.
const FORWARDED_ROOT = "/reviews-api";

// Browser credentials and caller-chosen review tokens stop at the proxy; the
// backend's own token is the only one the review server ever sees.
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-review-token",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-allow-private-network",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Canvas UI telemetry and bug reports go to Desktop's reporting routes, which
// the headless server does not mount. The spike collects nothing, so the
// proxy answers them itself and they never leave the container.
const DISCARDED_PATH = /^\/reviews-api\/[^/]+\/telemetry\//;

export function isDiscardedPath(pathname: string): boolean {
  return DISCARDED_PATH.test(pathname);
}

/**
 * Maps a path below the proxy mount to the review server, or returns null when
 * it would leave `/reviews-api`. `..` segments are resolved before the check,
 * and a caller-supplied `token` query parameter is removed.
 */
export function reviewProxyTarget(
  pathAndQuery: string,
  serverUrl: string,
): URL | null {
  const target = new URL(pathAndQuery, serverUrl);

  if (target.origin !== new URL(serverUrl).origin) return null;

  if (
    target.pathname !== FORWARDED_ROOT &&
    !target.pathname.startsWith(`${FORWARDED_ROOT}/`)
  )
    return null;

  target.searchParams.delete("token");

  return target;
}

/**
 * Whether a request carrying an Origin was sent from a page on the host it
 * was sent to (Host, or X-Forwarded-Host behind a proxy). Requests without an
 * Origin (curl, agents) are not cross-site.
 */
export function isCrossSiteRequest(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;

  if (!origin) return false;

  let originHost: string;

  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }

  const forwardedHost = headers["x-forwarded-host"];

  const hosts = [
    headers.host,
    ...(Array.isArray(forwardedHost) ? forwardedHost : [forwardedHost]),
  ].filter((host): host is string => Boolean(host));

  return !hosts.some((host) => host.split(",")[0]?.trim() === originHost);
}

/**
 * The proxy has no session of its own, so a state-changing request is only
 * accepted from a page Theia served: its Origin must match the Host it was
 * sent to. Requests without an Origin (curl, agents) are allowed; put an
 * authenticating reverse proxy in front before exposing the port.
 */
export function isCrossSiteWrite(
  method: string,
  headers: IncomingHttpHeaders,
): boolean {
  return !SAFE_METHODS.has(method.toUpperCase()) && isCrossSiteRequest(headers);
}

function copyHeaders(
  headers: IncomingHttpHeaders,
  dropped: ReadonlySet<string>,
): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !dropped.has(name)) copied[name] = value;
  }

  return copied;
}

export function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  token: string,
): OutgoingHttpHeaders {
  return {
    ...copyHeaders(headers, DROPPED_REQUEST_HEADERS),
    "x-review-token": token,
  };
}

function sendError(response: ServerResponse, status: number, error: string) {
  if (response.headersSent) {
    response.destroy();

    return;
  }

  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
}

/**
 * A streaming reverse proxy for the review API. Streaming matters: `/watch`
 * and structural diffs hold the response open and write events as they come.
 */
export function createReviewProxy(
  connection: () => Promise<ReviewServerConnection>,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";

    if (isCrossSiteWrite(method, request.headers)) {
      sendError(response, 403, "Cross-site request refused.");

      return;
    }

    let server: ReviewServerConnection;

    try {
      server = await connection();
    } catch (error) {
      sendError(
        response,
        503,
        `Review server unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );

      return;
    }

    const target = reviewProxyTarget(request.url ?? "/", server.url);

    if (!target) {
      sendError(response, 404, "Not found.");

      return;
    }

    if (isDiscardedPath(target.pathname)) {
      request.resume();
      response.writeHead(204).end();

      return;
    }

    const upstream = httpRequest(target, {
      method,
      headers: forwardedRequestHeaders(request.headers, server.token),
    });

    upstream.on("response", (reply) => {
      response.writeHead(
        reply.statusCode ?? 502,
        copyHeaders(reply.headers, DROPPED_RESPONSE_HEADERS),
      );
      reply.pipe(response);
    });
    upstream.on("error", (error) =>
      sendError(response, 502, `Review server error: ${error.message}`),
    );
    // A closed browser tab must also end long-lived watch streams upstream.
    response.on("close", () => upstream.destroy());

    request.pipe(upstream);
  };
}
