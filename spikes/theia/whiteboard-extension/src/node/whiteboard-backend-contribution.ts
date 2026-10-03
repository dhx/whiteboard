import path from "node:path";

import {
  BackendApplicationContribution,
  EarlyExpressMiddleware,
} from "@theia/core/lib/node/backend-application";
import type { WsRequestValidatorContribution } from "@theia/core/lib/node/ws-request-validators";
import express from "@theia/core/shared/express";
import { inject, injectable } from "@theia/core/shared/inversify";

import {
  WHITEBOARD_API_PATH,
  WHITEBOARD_CANVAS_PATH,
} from "../common/whiteboard-paths";
import { GatewayGuard, agentTokenRoutes, mcpEndpoint } from "./agent-access";
import { AgentTokenStore, agentTokenFile } from "./agent-tokens";
import { readCanvasLoader } from "./canvas-assets";
import { mcpHandlerLoader } from "./mcp-handler";
import { createReviewProxy } from "./review-proxy";
import {
  ReviewServerProcess,
  reviewServerOptionsFromEnv,
} from "./review-server-process";

@injectable()
export class WhiteboardBackendContribution
  implements BackendApplicationContribution, WsRequestValidatorContribution
{
  @inject(EarlyExpressMiddleware)
  protected readonly earlyMiddleware!: EarlyExpressMiddleware;

  private readonly options = reviewServerOptionsFromEnv();
  private readonly server = new ReviewServerProcess(this.options);
  private readonly tokens = new AgentTokenStore(
    agentTokenFile(process.env, this.options.stateDir),
  );
  // Set in the Coolify deployment, where the gateway shares it.
  private readonly guard = new GatewayGuard(
    process.env.WHITEBOARD_GATEWAY_SECRET?.trim() || undefined,
  );

  allowWsUpgrade(
    request: Parameters<WsRequestValidatorContribution["allowWsUpgrade"]>[0],
  ) {
    return this.guard.allowsWebSocket(request);
  }

  initialize() {
    // Before Theia's own routes and static files.
    this.earlyMiddleware.handlers.push(this.guard.middleware());

    // Start early so the first canvas does not wait for SQLite to open, but
    // never fail Theia's startup over it; requests report the error instead.
    this.server.connection().catch((error) => {
      console.error("[whiteboard] review server failed to start:", error);
    });
  }

  configure(app: express.Application) {
    app.use(
      mcpEndpoint({
        tokens: this.tokens,
        reviewServer: () => this.server.connection(),
        handler: mcpHandlerLoader(this.options.cli),
      }),
    );
    app.use(agentTokenRoutes(this.tokens));
    app.use(
      WHITEBOARD_API_PATH,
      createReviewProxy(() => this.server.connection()),
    );

    const canvasDir = process.env.WHITEBOARD_CANVAS_DIR?.trim();

    if (!canvasDir) {
      console.error(
        "[whiteboard] WHITEBOARD_CANVAS_DIR is not set; the canvas cannot load.",
      );

      return;
    }

    const loader = readCanvasLoader(path.resolve(canvasDir));
    loader.catch((error) =>
      console.error("[whiteboard] canvas build not found:", error),
    );

    app.get(
      `${WHITEBOARD_CANVAS_PATH}/canvas-loader.js`,
      async (_request, response) => {
        try {
          response.type("text/javascript").send(await loader);
        } catch (error) {
          response.status(500).send(String(error));
        }
      },
    );
    app.use(
      WHITEBOARD_CANVAS_PATH,
      express.static(path.resolve(canvasDir), {
        dotfiles: "ignore",
        immutable: true,
        maxAge: "1y",
      }),
    );
  }

  onStop() {
    this.server.stop();
  }
}
