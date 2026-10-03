import { AgentTokenStore, agentTokenFile } from "./agent-tokens";
import { reviewServerOptionsFromEnv } from "./review-server-process";

const USAGE = `Usage: node agent-tokens-cli.js list | revoke <id>

Lists or revokes Whiteboard agent tokens from a shell in the container, e.g.
when the UI is unreachable. Tokens are created only in the UI (Whiteboard:
Create Agent Token...), so a token never passes through a shell or transcript.
Reads $WHITEBOARD_AGENT_TOKENS_FILE, else agent-tokens.json next to
$WHITEBOARD_STATE_DIR.
`;

export async function runAgentTokensCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
) {
  const store = new AgentTokenStore(
    agentTokenFile(env, reviewServerOptionsFromEnv(env).stateDir),
  );

  const [command, id, ...rest] = args;

  if (command === "list" && id === undefined) {
    const rows = (await store.list()).map((token) =>
      [
        token.id,
        token.revokedAt ? `revoked ${token.revokedAt}` : "active",
        token.scope,
        `created ${token.createdAt}`,
        `last used ${token.lastUsedAt ?? "never"}`,
        JSON.stringify(token.name),
      ].join("  "),
    );

    write(rows.length ? `${rows.join("\n")}\n` : "No agent tokens.\n");

    return 0;
  }

  if (command === "revoke" && id && rest.length === 0) {
    const revoked = await store.revoke(id);

    if (!revoked) {
      write(`No agent token with id ${id}.\n`);

      return 1;
    }

    write(`Revoked ${revoked.id} (${JSON.stringify(revoked.name)}).\n`);

    return 0;
  }

  write(USAGE);

  return command === "help" || command === "--help" ? 0 : 2;
}

if (require.main === module) {
  runAgentTokensCli(process.argv.slice(2), process.env, (text) =>
    process.stdout.write(text),
  ).then(
    (code) => process.exit(code),
    (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}
