import { timingSafeEqual } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";

import express from "@theia/core/shared/express";
import { z } from "zod";

import { agentTokenNameSchema } from "../common/agent-token-types";
import {
  WHITEBOARD_AGENT_TOKENS_PATH,
  WHITEBOARD_GATEWAY_HEADER,
  WHITEBOARD_MCP_PATH,
} from "../common/whiteboard-paths";
import {
  AGENT_TOKEN_SCOPES,
  type AgentTokenCheck,
  type AgentTokenStore,
} from "./agent-tokens";
import {
  type ReviewServerConnection,
  isCrossSiteRequest,
  isCrossSiteWrite,
} from "./review-proxy";

/** The `@dev.fast/review` entry that answers one MCP HTTP request. */
export type McpHttpHandler = (
  endpoint: ReviewServerConnection,
  request: IncomingMessage,
  response: ServerResponse,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON-RPC transport boundary; the MCP transport parses each message.
  body: unknown,
  options: {
    readOnly?: boolean;
    onToolCall?: (call: { tool: string; ok: boolean }) => void;
  },
) => Promise<void>;

/** The token from `Authorization: Bearer <token>`, or undefined. */
export function bearerToken(headers: IncomingHttpHeaders) {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(headers.authorization ?? "");

  return match?.[1];
}

function hasBearer(headers: IncomingHttpHeaders) {
  return /^Bearer\b/i.test(headers.authorization ?? "");
}

function sameSecret(presented: string | string[] | undefined, secret: string) {
  if (presented === undefined || Array.isArray(presented)) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);

  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Defence in depth behind the gateway. With a gateway secret configured,
 * every request except the MCP endpoint must carry the header the gateway
 * sets only after basic auth, and no request except the MCP endpoint may
 * carry a Bearer token. Without a secret (local `compose.yaml`), only the
 * Bearer rule applies.
 */
export class GatewayGuard {
  constructor(private readonly secret: string | undefined) {}

  /** Whether a request for `path` may reach anything but the MCP endpoint. */
  allows(path: string, headers: IncomingHttpHeaders) {
    if (path === WHITEBOARD_MCP_PATH) return true;

    if (hasBearer(headers)) return false;

    return (
      this.secret === undefined ||
      sameSecret(headers[WHITEBOARD_GATEWAY_HEADER], this.secret)
    );
  }

  middleware(): express.Handler {
    return (request, response, next) => {
      if (this.allows(request.path, request.headers)) {
        next();

        return;
      }

      response
        .status(403)
        .json({ error: "Forbidden: sign in through the Whiteboard gateway." });
    };
  }

  /** socket.io handshakes (polling and WebSocket) for Theia's own channels. */
  allowsWebSocket(request: IncomingMessage) {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    return path !== WHITEBOARD_MCP_PATH && this.allows(path, request.headers);
  }
}

/**
 * Failed token attempts per client address, to slow down guessing. The
 * address is the first hop of X-Forwarded-For (what the outermost proxy
 * saw), else the socket address.
 */
export class FailedAttemptLimit {
  private readonly failures = new Map<
    string,
    { count: number; since: number }
  >();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  static clientAddress(request: IncomingMessage) {
    const forwarded = request.headers["x-forwarded-for"];

    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      ?.trim();

    return first || request.socket.remoteAddress || "unknown";
  }

  /** Milliseconds until the address may try again, or 0. */
  blockedFor(address: string) {
    const entry = this.failures.get(address);

    if (!entry) return 0;

    const remaining = entry.since + this.windowMs - this.now();

    if (remaining <= 0) {
      this.failures.delete(address);

      return 0;
    }

    return entry.count >= this.limit ? remaining : 0;
  }

  fail(address: string) {
    const now = this.now();
    const entry = this.failures.get(address);

    if (!entry || entry.since + this.windowMs <= now)
      this.failures.set(address, { count: 1, since: now });
    else entry.count++;

    // Bound memory under a flood of distinct addresses.
    if (this.failures.size > 10_000) {
      for (const [key, value] of this.failures)
        if (value.since + this.windowMs <= now) this.failures.delete(key);
    }
  }
}

export interface McpEndpointOptions {
  tokens: AgentTokenStore;
  reviewServer: () => Promise<ReviewServerConnection>;
  handler: () => Promise<McpHttpHandler>;
  limit?: FailedAttemptLimit;
  log?: (line: string) => void;
}

const UNAUTHORIZED = 'Bearer realm="whiteboard"';

/** A JSON-RPC message's method for the access log; replies have none. */
const loggedRpcMessage = z
  .object({ method: z.string() })
  .transform((message) => message.method.slice(0, 64))
  .catch("response");

const loggedRpcBody = z.union([
  z.array(loggedRpcMessage),
  loggedRpcMessage.transform((method) => [method]),
]);

/** JSON-RPC method names in a request body, for the access log. */
function rpcMethods(request: express.Request) {
  if (request.body === undefined) return "-";

  return loggedRpcBody.parse(request.body).join(",");
}

/**
 * `POST /whiteboard/mcp`: MCP Streamable HTTP for agents with a token. GET
 * and DELETE answer 405 (stateless server: no SSE stream, no sessions).
 */
export function mcpEndpoint(options: McpEndpointOptions): express.Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const limit = options.limit ?? new FailedAttemptLimit();
  const log = options.log ?? ((line: string) => console.info(line));
  const json = express.json({ limit: "10mb", type: () => true });

  router.all(WHITEBOARD_MCP_PATH, (request, response) => {
    void serve(request, response);
  });

  async function serve(request: express.Request, response: express.Response) {
    const address = FailedAttemptLimit.clientAddress(request);
    let check: AgentTokenCheck | undefined;
    const tools: string[] = [];

    response.on("finish", () => {
      const who = check?.ok
        ? `token=${check.token.id} name=${JSON.stringify(check.token.name)}`
        : `token=none reason=${check?.reason ?? "missing"}`;

      log(
        `[whiteboard] mcp ${request.method} ${who} rpc=${rpcMethods(request)} tools=${tools.join(",") || "-"} status=${response.statusCode}`,
      );
    });

    // The MCP spec asks servers to validate Origin against DNS rebinding.
    if (isCrossSiteRequest(request.headers)) {
      response.status(403).json({ error: "Origin not allowed." });

      return;
    }

    const wait = limit.blockedFor(address);

    if (wait > 0) {
      response
        .status(429)
        .set("Retry-After", String(Math.ceil(wait / 1000)))
        .json({ error: "Too many failed attempts." });

      return;
    }

    const presented = bearerToken(request.headers);

    if (!presented) {
      response
        .status(401)
        .set("WWW-Authenticate", UNAUTHORIZED)
        .json({ error: "An agent token is required (Authorization: Bearer)." });

      return;
    }

    try {
      check = await options.tokens.verify(presented);
    } catch (error) {
      // Fail closed if the token file cannot be read.
      console.error("[whiteboard] agent tokens unavailable:", error);
      response.status(503).json({ error: "Agent tokens are unavailable." });

      return;
    }

    if (!check.ok) {
      limit.fail(address);
      response
        .status(401)
        .set("WWW-Authenticate", `${UNAUTHORIZED}, error="invalid_token"`)
        .json({ error: "The agent token is invalid or revoked." });

      return;
    }

    if (request.method !== "POST") {
      response
        .status(405)
        .set("Allow", "POST")
        .json({ error: "This MCP endpoint is stateless; use POST." });

      return;
    }

    // Parse the body only for an authenticated agent.
    const parsed = await new Promise<Error | undefined>((resolve) =>
      json(request, response, (error?: Error) => resolve(error)),
    );

    if (parsed) {
      response.status(400).json({ error: parsed.message });

      return;
    }

    try {
      const [endpoint, handle] = await Promise.all([
        options.reviewServer(),
        options.handler(),
      ]);

      await handle(endpoint, request, response, request.body, {
        readOnly: check.token.scope === "read",
        onToolCall: (call) =>
          tools.push(`${call.tool}:${call.ok ? "ok" : "error"}`),
      });
    } catch (error) {
      console.error("[whiteboard] mcp request failed:", error);

      if (!response.headersSent)
        response.status(503).json({ error: "Whiteboard is unavailable." });
    }
  }

  return router;
}

/** Express 4 does not catch rejected async handlers; answer 500 instead of hanging. */
function handled(
  route: (
    request: express.Request,
    response: express.Response,
  ) => Promise<void>,
): express.RequestHandler {
  return (request, response) => {
    route(request, response).catch((error: Error) => {
      console.error("[whiteboard] agent token request failed:", error);

      if (!response.headersSent)
        response.status(500).json({ error: "Agent tokens are unavailable." });
    });
  };
}

const createSchema = z.object({
  name: agentTokenNameSchema,
  scope: z.enum(AGENT_TOKEN_SCOPES).default("write"),
});

/**
 * `/whiteboard/admin/agent-tokens`: list, create and revoke agent tokens. For
 * the owner only, i.e. whoever passed the gateway's basic auth; a request
 * with a Bearer token (an agent) is refused, as are cross-site writes.
 */
export function agentTokenRoutes(tokens: AgentTokenStore): express.Router {
  const router = express.Router({ caseSensitive: true, strict: true });

  router.use(WHITEBOARD_AGENT_TOKENS_PATH, (request, response, next) => {
    response.set("Cache-Control", "no-store");

    if (hasBearer(request.headers)) {
      response
        .status(403)
        .json({ error: "Agent tokens cannot manage tokens." });

      return;
    }

    if (isCrossSiteWrite(request.method, request.headers)) {
      response.status(403).json({ error: "Cross-site request refused." });

      return;
    }

    next();
  });
  router.use(WHITEBOARD_AGENT_TOKENS_PATH, express.json({ limit: "16kb" }));

  router.get(
    WHITEBOARD_AGENT_TOKENS_PATH,
    handled(async (_request, response) => {
      response.json(await tokens.list());
    }),
  );

  router.post(
    WHITEBOARD_AGENT_TOKENS_PATH,
    handled(async (request, response) => {
      const input = createSchema.safeParse(request.body);

      if (!input.success) {
        response
          .status(400)
          .json({ error: input.error.issues[0]?.message ?? "Invalid input." });

        return;
      }

      const created = await tokens.create(input.data.name, input.data.scope);

      console.info(
        `[whiteboard] agent token created id=${created.info.id} name=${JSON.stringify(created.info.name)} scope=${created.info.scope}`,
      );
      response.status(201).json(created);
    }),
  );

  router.post(
    `${WHITEBOARD_AGENT_TOKENS_PATH}/:id/revoke`,
    handled(async (request, response) => {
      const id = String(request.params.id);

      const revoked = /^[0-9a-f]{8}$/.test(id)
        ? await tokens.revoke(id)
        : undefined;

      if (!revoked) {
        response.status(404).json({ error: "No such token." });

        return;
      }

      console.info(`[whiteboard] agent token revoked id=${revoked.id}`);
      response.json(revoked);
    }),
  );

  return router;
}
