import { injectable } from "@theia/core/shared/inversify";

import type { ReviewCanvasModule } from "../common/review-protocol";
import { WHITEBOARD_CANVAS_PATH } from "../common/whiteboard-paths";
import { pageUrl } from "./whiteboard-api";

export interface WhiteboardCanvasAssets extends ReviewCanvasModule {
  reviewWasmUrl: string;
  reviewStylesheetUrls: string[];
}

function loadStylesheet(href: string) {
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Could not load ${href}`));
    document.head.append(link);
  });
}

/**
 * Loads the canvas bundle Code-OSS uses, unchanged. It is an ES module built
 * by `packages/review/app` (Vite) and imported at runtime by URL, which the
 * Theia bundler leaves alone, so the two builds stay independent.
 */
@injectable()
export class WhiteboardCanvasLoader {
  private assets: Promise<WhiteboardCanvasAssets> | undefined;

  load(): Promise<WhiteboardCanvasAssets> {
    this.assets ??= this.import().catch((error) => {
      this.assets = undefined;
      throw error;
    });

    return this.assets;
  }

  private async import(): Promise<WhiteboardCanvasAssets> {
    // Zod probes `Function` unless told not to; same setting as Code-OSS.
    // SAFETY: only this optional config slot is read or written on globalThis.
    const canvasGlobal = globalThis as {
      __zod_globalConfig?: { jitless?: boolean };
    };

    canvasGlobal.__zod_globalConfig ??= {};
    canvasGlobal.__zod_globalConfig.jitless = true;

    const url = pageUrl(`${WHITEBOARD_CANVAS_PATH}/canvas-loader.js`);
    // SAFETY: the backend generates canvas-loader.js from the canvas build
    // manifest (`canvasLoaderSource`) with exactly these exports; the mount
    // function is checked below before anything calls it.
    const assets = (await import(url)) as WhiteboardCanvasAssets;

    if (!(assets.mountReviewCanvas instanceof Function))
      throw new Error("Whiteboard canvas bundle has no mount function.");

    await Promise.all(assets.reviewStylesheetUrls.map(loadStylesheet));

    return assets;
  }
}
