import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import type { ReviewServerConnection } from "./review-proxy";

export interface ReviewServerOptions {
  /** `packages/review/dist/cli.js`; required unless `url` and `token` are set. */
  cli?: string;
  stateDir: string;
  /** Connect to a server that is already running instead of starting one. */
  url?: string;
  token?: string;
  softwareMaps: boolean;
}

export function reviewServerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReviewServerOptions {
  return {
    cli: env.WHITEBOARD_REVIEW_CLI?.trim() || undefined,
    stateDir: path.resolve(
      env.WHITEBOARD_STATE_DIR?.trim() || path.join(homedir(), ".whiteboard"),
    ),
    url: env.WHITEBOARD_SERVER_URL?.trim() || undefined,
    token: env.WHITEBOARD_SERVER_TOKEN?.trim() || undefined,
    softwareMaps: env.WHITEBOARD_SOFTWARE_MAPS !== "0",
  };
}

const READY_TIMEOUT_MS = 30_000;

/**
 * Owns the headless review server for this Theia backend. The server binds to
 * 127.0.0.1 and writes its token to a private discovery file; the token is
 * read here and never sent to the browser.
 */
export class ReviewServerProcess {
  private child: ChildProcess | undefined;
  private started: Promise<ReviewServerConnection> | undefined;

  constructor(private readonly options: ReviewServerOptions) {}

  connection(): Promise<ReviewServerConnection> {
    this.started ??= this.start().catch((error) => {
      // Let the next request try again instead of caching the failure.
      this.started = undefined;
      throw error;
    });

    return this.started;
  }

  stop() {
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.started = undefined;
  }

  private async start(): Promise<ReviewServerConnection> {
    const { url, token, cli, stateDir, softwareMaps } = this.options;

    if (url && token) return { url, token };

    if (!cli)
      throw new Error(
        "Set WHITEBOARD_REVIEW_CLI to packages/review/dist/cli.js, or WHITEBOARD_SERVER_URL and WHITEBOARD_SERVER_TOKEN.",
      );

    const args = [cli, "server", "start", "--json", "--state-dir", stateDir];

    if (softwareMaps) args.push("--software-maps");

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });

    this.child = child;

    const ready = await new Promise<{ url: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Review server did not become ready.")),
        READY_TIMEOUT_MS,
      );

      const lines = createInterface({ input: child.stdout! });

      lines.on("line", (line) => {
        const event = readyEventSchema.safeParse(parseJsonLine(line));

        if (event.success) {
          clearTimeout(timer);
          resolve(event.data);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Review server exited with code ${code}.`));
      });
    });

    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.started = undefined;
      }
    });

    return {
      url: ready.url,
      token: await readDiscoveryToken(stateDir, ready.url),
    };
  }
}

// `review server start --json` prints this line once it is listening.
const readyEventSchema = z.object({
  event: z.literal("server.ready"),
  url: z.url(),
});

// The private discovery file the server writes next to its database.
const discoverySchema = z.object({ url: z.url(), token: z.string().min(1) });

function parseJsonLine(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function readDiscoveryToken(stateDir: string, url: string) {
  const discovery = discoverySchema.parse(
    JSON.parse(
      await readFile(
        path.join(stateDir, "review-server", "server.json"),
        "utf8",
      ),
    ),
  );

  if (discovery.url !== url)
    throw new Error("Review server discovery file does not match the server.");

  return discovery.token;
}
