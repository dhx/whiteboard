import path from "node:path";
import { pathToFileURL } from "node:url";

import type { McpHttpHandler } from "./agent-access";

/**
 * Loads `handleReviewMcpHttpRequest` from the `@dev.fast/review` build the
 * review server runs from (`dist/mcp-http.js` next to `dist/cli.js`), so the
 * MCP tools, their schemas and the MCP SDK are the review package's own.
 */
export function mcpHandlerLoader(cli: string | undefined) {
  let loading: Promise<McpHttpHandler> | undefined;

  return () => {
    loading ??= load(cli).catch((error: Error) => {
      loading = undefined;

      throw error;
    });

    return loading;
  };
}

async function load(cli: string | undefined): Promise<McpHttpHandler> {
  if (!cli)
    throw new Error(
      "The MCP endpoint needs WHITEBOARD_REVIEW_CLI (packages/review/dist/cli.js).",
    );

  const module: { handleReviewMcpHttpRequest?: McpHttpHandler } = await import(
    pathToFileURL(path.join(path.dirname(cli), "mcp-http.js")).href
  );

  if (!(module.handleReviewMcpHttpRequest instanceof Function))
    throw new Error("The review build has no MCP HTTP handler; rebuild it.");

  return module.handleReviewMcpHttpRequest;
}
