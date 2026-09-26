import { readFile } from "node:fs/promises";
import path from "node:path";

interface ManifestEntry {
  file: string;
  name?: string;
  isEntry?: boolean;
  css?: string[];
  assets?: string[];
}

/**
 * The same loader `apps/review-desktop/scripts/copy-canvas.mjs` writes next to
 * the canvas for Code-OSS: one module that re-exports the mount function and
 * resolves the WASM and stylesheet URLs against its own location.
 */
export function canvasLoaderSource(manifest: Record<string, ManifestEntry>) {
  const canvas = Object.values(manifest).find(
    (entry) => entry.isEntry && entry.name === "canvas",
  );

  if (!canvas) throw new Error("Review canvas manifest has no canvas entry.");

  const wasm = (canvas.assets ?? []).find((file) => file.endsWith(".wasm"));

  if (!wasm)
    throw new Error("Review canvas manifest has no libavoid WASM asset.");

  return [
    `export { clearReviewViewState, mountReviewCanvas } from ${JSON.stringify(`./${canvas.file}`)};`,
    `export const reviewWasmUrl = new URL(${JSON.stringify(`./${wasm}`)}, import.meta.url).href;`,
    `export const reviewStylesheetUrls = ${JSON.stringify((canvas.css ?? []).map((file) => `./${file}`))}.map(file => new URL(file, import.meta.url).href);`,
    "",
  ].join("\n");
}

/** `packages/review/app/dist/desktop`, the output of the canvas build. */
export async function readCanvasLoader(canvasDir: string) {
  const manifest: Record<string, ManifestEntry> = JSON.parse(
    await readFile(path.join(canvasDir, ".vite", "manifest.json"), "utf8"),
  );

  return canvasLoaderSource(manifest);
}
