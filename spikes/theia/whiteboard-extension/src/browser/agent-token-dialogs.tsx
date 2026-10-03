import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import { ReactDialog } from "@theia/core/lib/browser/dialogs/react-dialog";
import * as React from "@theia/core/shared/react";

import type {
  AgentTokenInfo,
  CreatedAgentToken,
} from "../common/agent-token-types";
import type { AgentTokensClient } from "./agent-tokens-client";

function CopyField(props: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(props.value);
    setCopied(true);
  };

  return (
    <div className="whiteboard-token-field">
      <div className="whiteboard-token-label">{props.label}</div>
      <div className="whiteboard-token-row">
        {props.multiline ? (
          <pre className="whiteboard-token-value">{props.value}</pre>
        ) : (
          <input
            className="theia-input whiteboard-token-value"
            readOnly
            value={props.value}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        <button
          type="button"
          className="theia-button secondary"
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Shows a new token once, with the line that connects Claude Code. */
export class CreatedAgentTokenDialog extends ReactDialog<void> {
  constructor(
    private readonly created: CreatedAgentToken,
    private readonly command: string,
  ) {
    super({ title: `Agent token "${created.info.name}"`, maxWidth: 760 });
    this.appendCloseButton("Done");
  }

  get value(): undefined {
    return undefined;
  }

  protected render(): React.ReactNode {
    const { token, info } = this.created;

    return (
      <div className="whiteboard-token-dialog">
        <p>
          <strong>Copy the token now.</strong> Whiteboard shows it only this
          once and keeps only a hash of it.
        </p>
        <CopyField label="Token" value={token} />
        <CopyField label="Connect Claude Code" value={this.command} multiline />
        <p className="whiteboard-token-note">
          {info.scope === "read"
            ? "This token can read every review but change none."
            : "This token can read and change every review on this Whiteboard."}{" "}
          Revoke it under Whiteboard: Manage Agent Tokens when the agent no
          longer needs it; the next request with it is refused.
        </p>
      </div>
    );
  }
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : "never";
}

/** Lists agent tokens and revokes them. */
export class ManageAgentTokensDialog extends ReactDialog<void> {
  private tokens: AgentTokenInfo[] | undefined;
  private error: string | undefined;

  constructor(private readonly client: AgentTokensClient) {
    super({ title: "Agent tokens", maxWidth: 900 });
    this.appendCloseButton("Close");
    void this.reload();
  }

  get value(): undefined {
    return undefined;
  }

  private async reload() {
    try {
      this.tokens = await this.client.list();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }

    this.update();
  }

  private async revoke(token: AgentTokenInfo) {
    const confirmed = await new ConfirmDialog({
      title: "Revoke agent token",
      msg: `Revoke "${token.name}" (${token.id})? Agents using it are refused from their next request. This cannot be undone.`,
      ok: "Revoke",
    }).open();

    if (!confirmed) return;

    try {
      await this.client.revoke(token.id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }

    await this.reload();
  }

  protected render(): React.ReactNode {
    if (this.error)
      return <p className="whiteboard-token-error">{this.error}</p>;

    if (!this.tokens) return <p>Loading…</p>;

    if (this.tokens.length === 0)
      return (
        <p>
          No agent tokens yet. Create one with Whiteboard: Create Agent Token….
        </p>
      );

    return (
      <table className="whiteboard-token-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Id</th>
            <th>Access</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {this.tokens.map((token) => (
            <tr
              key={token.id}
              className={token.revokedAt ? "whiteboard-token-revoked" : ""}
            >
              <td>{token.name}</td>
              <td>
                <code>{token.id}</code>
              </td>
              <td>{token.scope === "read" ? "read only" : "read and write"}</td>
              <td>{when(token.createdAt)}</td>
              <td>{when(token.lastUsedAt)}</td>
              <td>
                {token.revokedAt
                  ? `revoked ${when(token.revokedAt)}`
                  : "active"}
              </td>
              <td>
                {!token.revokedAt && (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={() => void this.revoke(token)}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
}
