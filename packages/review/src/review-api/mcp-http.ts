import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ReviewToolCall } from "@review/review-telemetry.js";

import { ReviewApiClient } from "./client.js";
import { createReviewMcpServer } from "./mcp.js";
import { REVIEW_VIA_HEADER } from "./request-origin.js";

/** A review server that is already running, e.g. one a web host started. */
export interface ReviewServerEndpoint {
  url: string;
  token: string;
}

export interface ReviewMcpHttpRequestOptions {
  /** Expose only the tools that read. */
  readOnly?: boolean;
  /** Called once per tool call with its catalog name and outcome. */
  onToolCall?: (call: ReviewToolCall) => void;
}

/**
 * Answers one MCP Streamable HTTP request for a review server that is already
 * running. Stateless: every request gets its own server and transport, and
 * replies are plain JSON, so nothing is held between requests and proxies see
 * ordinary request/response traffic. Authentication is the caller's job; the
 * review server token stays in this process.
 */
export async function handleReviewMcpHttpRequest(
  endpoint: ReviewServerEndpoint,
  request: IncomingMessage,
  response: ServerResponse,
  /** The JSON body, already parsed by the caller. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON-RPC transport boundary; the MCP transport parses each message.
  body: unknown,
  options: ReviewMcpHttpRequestOptions = {},
) {
  const client = new ReviewApiClient(
    { serverUrl: endpoint.url, token: endpoint.token },
    (url, init) => {
      const headers = new Headers(init?.headers);

      headers.set(REVIEW_VIA_HEADER, "mcp");

      return fetch(url, { ...init, headers });
    },
  );

  const server = createReviewMcpServer(async () => ({ client }), {
    // A stateless request cannot carry a later tools/list_changed.
    announceToolChanges: false,
    readOnly: options.readOnly,
    onToolCall: options.onToolCall,
    stderr: process.stderr,
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  response.on("close", () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
