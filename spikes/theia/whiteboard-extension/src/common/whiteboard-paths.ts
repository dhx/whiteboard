/**
 * Same-origin prefixes the Theia backend serves. The browser only ever talks
 * to Theia; the review server stays on loopback behind the proxy, and its
 * token never reaches the page.
 */
export const WHITEBOARD_API_PATH = "/whiteboard/api";

export const WHITEBOARD_CANVAS_PATH = "/whiteboard/canvas";

/** Monaco and Theia editors read review sources through this URI scheme. */
export const WHITEBOARD_SOURCE_SCHEME = "whiteboard-source";

/**
 * The MCP endpoint for agents. Exact path: the gateway lets only this path
 * through without basic auth, and the backend checks the agent's token.
 */
export const WHITEBOARD_MCP_PATH = "/whiteboard/mcp";

/** Agent token management for the owner; never reachable with a token. */
export const WHITEBOARD_AGENT_TOKENS_PATH = "/whiteboard/admin/agent-tokens";

/**
 * Set by the gateway, only after basic auth, to a secret it shares with the
 * backend. Requests without it did not pass the gateway's basic auth.
 */
export const WHITEBOARD_GATEWAY_HEADER = "x-whiteboard-gateway";
