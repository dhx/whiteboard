import path from "node:path";

import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import express from "@theia/core/shared/express";
import { injectable } from "@theia/core/shared/inversify";

import {
  WHITEBOARD_API_PATH,
  WHITEBOARD_CANVAS_PATH,
} from "../common/whiteboard-paths";
import { readCanvasLoader } from "./canvas-assets";
import { createReviewProxy } from "./review-proxy";
import {
  ReviewServerProcess,
  reviewServerOptionsFromEnv,
} from "./review-server-process";

@injectable()
export class WhiteboardBackendContribution implements BackendApplicationContribution {
  private readonly server = new ReviewServerProcess(
    reviewServerOptionsFromEnv(),
  );

  initialize() {
    // Start early so the first canvas does not wait for SQLite to open, but
    // never fail Theia's startup over it; requests report the error instead.
    this.server.connection().catch((error) => {
      console.error("[whiteboard] review server failed to start:", error);
    });
  }

  configure(app: express.Application) {
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
