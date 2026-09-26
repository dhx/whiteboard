/**
 * Same-origin prefixes the Theia backend serves. The browser only ever talks
 * to Theia; the review server stays on loopback behind the proxy, and its
 * token never reaches the page.
 */
export const WHITEBOARD_API_PATH = "/whiteboard/api";

export const WHITEBOARD_CANVAS_PATH = "/whiteboard/canvas";

/** Monaco and Theia editors read review sources through this URI scheme. */
export const WHITEBOARD_SOURCE_SCHEME = "whiteboard-source";
