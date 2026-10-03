import { injectable } from "@theia/core/shared/inversify";
import { z } from "zod";

import {
  type AgentTokenInfo,
  agentTokenInfoSchema,
  createdAgentTokenSchema,
} from "../common/agent-token-types";
import {
  WHITEBOARD_AGENT_TOKENS_PATH,
  WHITEBOARD_MCP_PATH,
} from "../common/whiteboard-paths";
import { pageUrl } from "./whiteboard-api";

/** The owner's side of agent token management (behind the gateway's basic auth). */
@injectable()
export class AgentTokensClient {
  private readonly base = pageUrl(WHITEBOARD_AGENT_TOKENS_PATH);

  /** Where agents connect: this page's origin. */
  readonly mcpUrl = pageUrl(WHITEBOARD_MCP_PATH);

  async list(): Promise<AgentTokenInfo[]> {
    return z.array(agentTokenInfoSchema).parse(await this.send("GET", ""));
  }

  async create(name: string, scope: AgentTokenInfo["scope"]) {
    return createdAgentTokenSchema.parse(
      await this.send("POST", "", { name, scope }),
    );
  }

  async revoke(id: string): Promise<AgentTokenInfo> {
    return agentTokenInfoSchema.parse(
      await this.send("POST", `/${encodeURIComponent(id)}/revoke`),
    );
  }

  /** The command an owner runs to connect Claude Code with a new token. */
  claudeCommand(token: string) {
    return `claude mcp add --transport http whiteboard ${this.mcpUrl} --header "Authorization: Bearer ${token}"`;
  }

  private async send(
    method: "GET" | "POST",
    route: string,
    body?: { name: string; scope: AgentTokenInfo["scope"] },
  ) {
    const response = await fetch(`${this.base}${route}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(payload);

      throw new Error(
        error.success
          ? error.data.error
          : `Request failed (${response.status}).`,
      );
    }

    return payload;
  }
}
