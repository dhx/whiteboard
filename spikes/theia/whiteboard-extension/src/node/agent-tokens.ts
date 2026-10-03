import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { agentTokenNameSchema } from "../common/agent-token-types";

/** `wbat_<id>_<secret>`: a public 8-character id and a 32-byte secret. */
const TOKEN_PATTERN = /^wbat_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export const AGENT_TOKEN_SCOPES = ["write", "read"] as const;

export type AgentTokenScope = (typeof AGENT_TOKEN_SCOPES)[number];

const recordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}$/),
  name: z.string(),
  scope: z.enum(AGENT_TOKEN_SCOPES),
  /** SHA-256 of the secret, hex. The secret itself is never stored. */
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

const fileSchema = z.object({
  version: z.literal(1),
  tokens: z.array(recordSchema),
});

const usageSchema = z.record(z.string(), z.string());

type AgentTokenRecord = z.infer<typeof recordSchema>;

export type AgentToken = Omit<AgentTokenRecord, "secretHash"> & {
  lastUsedAt: string | null;
};

export type AgentTokenCheck =
  | { ok: true; token: AgentToken }
  | { ok: false; reason: "malformed" | "unknown" | "revoked" };

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest();
}

/** How often a token's last use is written back, at most. */
const USAGE_WRITE_INTERVAL_MS = 60_000;

/**
 * Agent tokens for the MCP endpoint, in a JSON file on the data volume.
 *
 * - The file holds only a SHA-256 of each secret.
 * - It is written atomically (temporary file, then rename) with mode 600.
 * - Every check reads it again (it is tiny), so a revocation applies to the
 *   next request, also when another process (the CLI) made it.
 * - Last use lives in a separate file, written at most once a minute per
 *   token, so routine use never rewrites the token file and cannot race with a
 *   revocation.
 */
export class AgentTokenStore {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly usageWritten = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get usageFile() {
    return this.file.replace(/\.json$/, "") + ".usage.json";
  }

  async list(): Promise<AgentToken[]> {
    const [tokens, usage] = await Promise.all([
      this.readTokens(),
      this.readUsage(),
    ]);

    return tokens.map((record) => this.summary(record, usage));
  }

  /** Returns the full token once; only its hash is kept. */
  async create(name: string, scope: AgentTokenScope = "write") {
    const parsedName = agentTokenNameSchema.parse(name);

    return this.serialized(async () => {
      const tokens = await this.readTokens();
      let id: string;

      do id = randomBytes(4).toString("hex");
      while (tokens.some((token) => token.id === id));

      const secret = randomBytes(32).toString("base64url");

      const record: AgentTokenRecord = {
        id,
        name: parsedName,
        scope,
        secretHash: hashSecret(secret).toString("hex"),
        createdAt: this.now().toISOString(),
        revokedAt: null,
      };

      await this.writeJson(this.file, {
        version: 1,
        tokens: [...tokens, record],
      });

      return {
        token: `wbat_${id}_${secret}`,
        info: this.summary(record, {}),
      };
    });
  }

  /** Revokes the token; returns undefined when no token has this id. */
  async revoke(id: string) {
    return this.serialized(async () => {
      const tokens = await this.readTokens();
      const record = tokens.find((token) => token.id === id);

      if (!record) return undefined;

      record.revokedAt ??= this.now().toISOString();
      await this.writeJson(this.file, { version: 1, tokens });

      return this.summary(record, await this.readUsage());
    });
  }

  async verify(presented: string): Promise<AgentTokenCheck> {
    const match = TOKEN_PATTERN.exec(presented);

    if (!match) return { ok: false, reason: "malformed" };

    const [, id, secret] = match;
    const record = (await this.readTokens()).find((token) => token.id === id);

    if (!record) return { ok: false, reason: "unknown" };

    const expected = Buffer.from(record.secretHash, "hex");

    if (!timingSafeEqual(expected, hashSecret(secret!)))
      return { ok: false, reason: "unknown" };

    if (record.revokedAt) return { ok: false, reason: "revoked" };

    const usage = await this.readUsage();
    const usedAt = this.now();

    this.recordUse(record.id, usedAt);

    return {
      ok: true,
      token: this.summary(record, {
        ...usage,
        [record.id]: usedAt.toISOString(),
      }),
    };
  }

  private recordUse(id: string, at: Date) {
    const last = this.usageWritten.get(id) ?? 0;

    if (at.getTime() - last < USAGE_WRITE_INTERVAL_MS) return;

    this.usageWritten.set(id, at.getTime());
    void this.serialized(async () => {
      const usage = await this.readUsage();

      await this.writeJson(this.usageFile, {
        ...usage,
        [id]: at.toISOString(),
      });
    }).catch((error) =>
      console.error("[whiteboard] could not record agent token use:", error),
    );
  }

  private summary(
    { secretHash: _secretHash, ...record }: AgentTokenRecord,
    usage: Record<string, string>,
  ): AgentToken {
    return { ...record, lastUsedAt: usage[record.id] ?? null };
  }

  private async readTokens(): Promise<AgentTokenRecord[]> {
    const text = await this.readText(this.file);

    return text === undefined ? [] : fileSchema.parse(JSON.parse(text)).tokens;
  }

  private async readUsage(): Promise<Record<string, string>> {
    const text = await this.readText(this.usageFile);

    if (text === undefined) return {};

    // Usage is informational; a damaged file must not lock agents out.
    try {
      const parsed = usageSchema.safeParse(JSON.parse(text));

      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private async readText(file: string) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;

      throw error;
    }
  }

  /** Writes a private file atomically: a temporary file, then a rename. */
  private async writeJson(
    file: string,
    value: z.infer<typeof fileSchema> | z.infer<typeof usageSchema>,
  ) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

    const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });

      throw error;
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation, operation);

    this.writes = next.catch(() => {});

    return next;
  }
}

/** Default: next to the review server's state directory, on the data volume. */
export function agentTokenFile(env: NodeJS.ProcessEnv, stateDir: string) {
  return path.resolve(
    env.WHITEBOARD_AGENT_TOKENS_FILE?.trim() ||
      path.join(path.dirname(stateDir), "agent-tokens.json"),
  );
}
