# Whiteboard in Eclipse Theia (spike)

A time-boxed spike that answers one question: **how much of Whiteboard runs
unchanged inside an [Eclipse Theia](https://theia-ide.org) browser app, served
from a container?** It is not a product and nothing here is supported.

The spike reuses Whiteboard's own pieces as they are:

- the review canvas (`packages/review/app`, the same `mountReviewCanvas` bundle
  Code-OSS loads), and
- the headless review server (`review server start` from `packages/review`).

It adds one Theia extension, `whiteboard-extension`, that hosts the canvas in a
Theia widget and implements the canvas bridge on Theia services.

## What works

| Area | Status |
| --- | --- |
| Home (review list) | Unchanged canvas, refreshed every 5 s. |
| Review document | Unchanged canvas. Prose, sections, code peeks and sequence diagrams were exercised; flow diagrams, maps and traces use the same renderer but were not. |
| Code peeks | Theia `SimpleMonacoEditor`s embedded in the canvas, reading source through a `whiteboard-source:` resource; only the referenced lines are shown. |
| Diff tab | **Semantic diff** from diffr (see [below](#semantic-diff)); each file also opens in Theia's own read-only diff editor. Falls back to a plain file list when diffr is unavailable. |
| "Reveal in editor" / "Open diff" from the canvas | Opens Theia editor tabs. |
| Agents authoring reviews | `whiteboard api` / `whiteboard mcp` against the server in the container (see below). |
| Live co-editing | [Open Collaboration Tools](#live-collaboration-open-collaboration-tools): shared editors with named cursors, host approval of each guest, self-hosted server. |
| Container | Multi-stage image; the review server runs as the unprivileged `node` user. |

## What does not (yet)

These are the gaps between this spike and the Theia plan, roughly in the order
they would need to be closed:

- **No per-user login.** The [Coolify deployment](#deploy-on-coolify) puts one
  shared basic-auth account in front of everything; the plain `compose.yaml`
  has none. Either way the review server has no users: everyone who gets in
  can read and write every review. See [Security](#security).
- **No syntax highlighting.** Theia ships no TextMate grammars by default; a
  real build adds `@theia/plugin-ext` plus the built-in VS Code language
  extensions (or Open VSX equivalents).
- **The semantic diff is read-only text, not an editor:** no hovers, go to
  definition or find inside it, no viewed/progress tracking, and no lens
  clipping beyond picking files. Click a line number to open that file in a
  Theia editor.
- **Desktop-only features are stubbed:** the tutorial, sharing (the share
  account endpoint 404s), bug reports, the source-tree tab, settings pages and
  the Welcome/install flow. Canvas UI telemetry is answered by the proxy with
  `204` and never leaves the container.
- **Home polls** every 5 s. An open review does update live: agent edits
  arrive over the canvas's own `/watch` stream through the proxy.
- **One review server per container.** The server is single-process by design
  (a file lock per state directory), so this is one shared workspace, not
  per-user isolation.

## Live collaboration (Open Collaboration Tools)

The app includes Theia's `@theia/collaboration` extension and a self-hosted
[Open Collaboration Tools](https://github.com/eclipse-oct/open-collaboration-tools)
(OCT) server (`oct-server/`, MIT; `compose.yaml` runs it as `collaboration`).

How a session works:

1. The host clicks **Collaborate** in the status bar, **Create New
   Collaboration Session**, and signs in to the OCT server. An invitation code
   is copied to the clipboard.
2. A guest clicks **Collaborate**, **Join Collaboration Session**, enters the
   code and signs in. The host sees "User '…' wants to join" and allows or
   denies it.
3. The guest sees the host's workspace, and must answer a Workspace Trust
   prompt for it. Both edit the same files with each other's named cursors.
   The host's copy is what is saved.

Tested with two browsers, locally and in the two containers: session
creation, join approval, edits in both directions with named cursors, the
result saved to the host's file, and Whiteboard (review canvas, semantic
diff) still usable by the guest during the session.

What OCT covers and what it does not:

- **Covered:** files and text editors: co-editing, cursors and selections,
  the guest browsing the host's workspace. Messages between participants are
  encrypted with per-session keys (per the protocol's source; not audited
  here), and the server only relays them.
- **Not covered: the Whiteboard canvas.** It is a custom widget, not a text
  editor, so OCT does not share it: no shared scrolling, pointers or
  selection on a review. In this single-container setup everyone already
  reads the same reviews, and agent edits appear live for all of them.
- **No follow mode** in the Theia 1.75 extension (the VS Code extension has
  one).
- **Rough edge:** when the host's copy of a file is saved while a guest has
  it open with edits, the guest gets a "file has been changed on the file
  system" dialog, although both copies are identical.
- Sessions live in the OCT server's memory, end when the host leaves, and the
  server does not scale horizontally.

Agents: OCT ships `open-collaboration-agent` (`oct-agent`), which joins a
session as a participant, takes `@agent …` prompts written in shared files,
and proposes changes as diffs the humans accept or reject, through any agent
that speaks the Agent Client Protocol (for example Claude Code via
`@zed-industries/claude-code-acp`). It must run in the host's workspace, i.e.
in the Whiteboard container. **Not tried in this spike.**

Upstream problems found and worked around:

- `@theia/collaboration` 1.75 builds login URLs as `http://host:8100//api/…`;
  the OCT server answers `404`, so every login fails its CORS preflight.
  `whiteboard-collaboration.ts` overrides the two methods to pass relative
  endpoints.
- `open-collaboration-server` 0.3.1: its `oct-server` bin imports a bundle
  the npm package does not ship, `--port` always parses to `NaN` (the port is
  fixed at 8100), and without `OCT_JWT_PRIVATE_KEY` it signs login tokens
  with a key published in its source. `oct-server/start.mjs` works around the
  first two and refuses to start without the key.

These are worth reporting upstream.

| Variable | Service | Meaning |
| --- | --- | --- |
| `OCT_JWT_PRIVATE_KEY` | collaboration | **Required.** Secret that signs login tokens, e.g. `openssl rand -hex 32`. |
| `COLLABORATION_SERVER_URL` | both | The OCT server's address **as the browser reaches it** (default `http://127.0.0.1:8100`, no trailing slash). |
| `WHITEBOARD_ORIGIN` | collaboration | Theia's address as the browser reaches it; the only CORS origin the OCT server accepts (default `http://127.0.0.1:3000`). |
| `OCT_ACTIVATE_SIMPLE_LOGIN` | collaboration | `true` (default here) lets anyone sign in with any name. Turn off and configure an identity provider for real use (`OCT_OAUTH_KEYCLOAK_*`, `OCT_OAUTH_GITHUB_*`, generic OIDC: see the OCT server README). |

## How it fits together

```
browser ──HTTP──▶ Theia backend (Node, :3000)
                   ├─ /                  Theia frontend
                   ├─ /whiteboard/canvas the canvas bundle (packages/review/app/dist/desktop)
                   └─ /whiteboard/api/*  proxy ──▶ review server (127.0.0.1:<random>)
                                                    └─ SQLite state in $WHITEBOARD_STATE_DIR
agents ── whiteboard api | whiteboard mcp ──────────▶ review server (discovery file)
```

- The Theia backend starts `review server start --json` as a child process,
  reads the token from the server's private discovery file, and **never sends
  it to the browser**. The proxy adds it to every forwarded request.
- The proxy only forwards `/reviews-api` and below, strips cookies,
  `Authorization`, and any caller-supplied `x-review-token` or `?token=`, and
  drops the review server's permissive CORS headers.
- The canvas bundle is loaded at runtime by URL, so the Vite build and the
  Theia build stay independent.

## Semantic diff

The Diff tab renders diffr's structural diff, the same engine and wire format
Review Desktop uses:

- The review server's `/structural-diff` route runs diffr and streams NDJSON
  records through the proxy. `StructuralDiffSession` validates them with the
  shared protocol decoder, applies summary labels as they arrive, and keeps the
  reader's folds for the review's lifetime.
- Rows are aligned by syntax (`structuralRows` from `@dev.fast/review-protocol`,
  the same table Desktop uses), so a moved or rewritten construct lines up
  with its counterpart instead of showing as a delete plus an add.
- Unchanged regions are folded into labelled bands (click to open; **Expand
  all** / **Reset folds** per file), changed tokens are tinted inside changed
  lines, and files diffr hides by default (tests, docs) are collapsed with its
  reason.
- Side by side or unified (toolbar toggle); colors come from the Theia theme's
  diff editor colors.

Why not Monaco: Review Desktop draws this inside its Monaco diff editor, which
the fork extends with row alignment, labelled bands and token highlights
(`sourceLineAlignment`, `contextGaps`, `changeHighlights` in
`documentDiffProvider.ts`). Theia uses stock Monaco, which has none of these,
so the spike renders diffr's output as HTML instead. The alternative is to
carry the same Monaco patches in a Theia build.

diffr ships as a pinned, checksummed release binary (`@dev.fast/diffr`, Linux
x64 and macOS arm64 only), about 150 MB. The image fetches it at build time;
build with `--build-arg DIFFR=skip` to leave it out. Its AI summaries of
unchanged code ("pseudocode" bands) are off unless diffr is configured with a
Gemini key (`plugins.bundled.summarize` in diffr's config); without them,
bands read "N unchanged lines".

Source layout:

- `whiteboard-extension/src/node`: the backend contribution, review server
  process, streaming proxy, and canvas loader generation.
- `whiteboard-extension/src/common`: the semantic diff model and session
  (DOM-free, unit tested), plus `review-protocol.ts`, generated at build time
  from `packages/review-protocol` by its own `generate-native-source.mjs`, the
  same way Code-OSS gets its copy.
- `whiteboard-extension/src/browser`: the widget, the canvas bridge (inline
  editors, semantic diff view, verbs, theme), the `whiteboard-source:`
  resource resolver, and commands (**View → Whiteboard**, **Whiteboard: Open
  Review by ID…**).
- `browser-app`: the Theia application (browser target, Theia 1.75).

## Run it locally

Needs Node 24 and pnpm 11 (the repository's toolchain).

```sh
# From the repository root: build the review runtime and the canvas, and
# fetch diffr for the semantic diff.
pnpm install
pnpm build
pnpm --filter @dev.fast/review ensure:diffr --required

# Build the Theia app.
cd spikes/theia
npm ci
npm run build

# Optional: the collaboration server, in its own terminal.
OCT_JWT_PRIVATE_KEY=$(openssl rand -hex 32) OCT_ACTIVATE_SIMPLE_LOGIN=true \
OCT_BASE_URL=http://127.0.0.1:8100 npm start --workspace oct-server

# Start the app.
COLLABORATION_SERVER_URL=http://127.0.0.1:8100 \
WHITEBOARD_REVIEW_CLI="$PWD/../../packages/review/dist/cli.js" \
WHITEBOARD_CANVAS_DIR="$PWD/../../packages/review/app/dist/desktop" \
WHITEBOARD_STATE_DIR="$HOME/.whiteboard-theia" \
npm start -- /path/to/a/checkout
```

Open <http://127.0.0.1:3000>. `npm test` runs the extension's unit tests.

| Variable | Meaning |
| --- | --- |
| `WHITEBOARD_REVIEW_CLI` | `packages/review/dist/cli.js`; the backend starts the review server with it. |
| `WHITEBOARD_CANVAS_DIR` | `packages/review/app/dist/desktop`, the canvas build. |
| `WHITEBOARD_STATE_DIR` | Review database and server discovery (default `~/.whiteboard`). |
| `WHITEBOARD_SERVER_URL`, `WHITEBOARD_SERVER_TOKEN` | Use an already running review server instead of starting one. |
| `WHITEBOARD_SOFTWARE_MAPS` | `0` stops agents from being offered software-map generation. |
| `REVIEW_DIFFR_BINARY` | diffr executable for the semantic diff (default `packages/review/bin/diffr`, fetched by `pnpm --filter @dev.fast/review ensure:diffr`, then `diffr` on `PATH`). |
| `WHITEBOARD_HOST`, `PORT` | Theia's bind address and port (default `127.0.0.1:3000` locally, `0.0.0.0:3000` in the image). |

## Run it in a container

```sh
# From the repository root.
docker build -f spikes/theia/Dockerfile -t whiteboard-theia .
docker run --rm --name wb -p 127.0.0.1:3000:3000 \
  -v whiteboard-data:/data \
  -v /path/to/checkouts:/workspace \
  whiteboard-theia
```

or, with the collaboration server:

```sh
OCT_JWT_PRIVATE_KEY=$(openssl rand -hex 32) \
WHITEBOARD_WORKSPACE=/path/to/checkouts \
docker compose -f spikes/theia/compose.yaml up --build
```

- `/data` holds the review database and Theia settings; keep it on a volume.
- `/workspace` holds the git checkouts reviews point at. They must be readable
  by uid 1000 (the image's `node` user).
- The default runtime image is `node:24-bookworm-slim` plus git. Pass
  `--build-arg RUNTIME_IMAGE=node:24-bookworm` to skip the apt step (larger
  image, which already includes git).
- Behind a TLS-intercepting proxy, pass its CA with
  `--secret id=ca,src=/path/to/ca.pem`.

## Deploy on Coolify

`coolify.yaml` is a Docker Compose application for
[Coolify](https://coolify.io) whose only way in is a gateway with two doors:
basic auth for people, and one exact path for agents with their own token.

```
Internet ─HTTPS─▶ Coolify proxy (TLS) ─▶ gateway (Caddy)
                                          ├─ /whiteboard/mcp (exact) ─▶ whiteboard:3000  (agent token)
                                          └─ basic auth
                                               ├─ /oct/*  ─▶ collaboration:8100
                                               └─ /*      ─▶ whiteboard:3000
```

- `gateway` is the only service with a domain. Theia and the collaboration
  server publish no ports and have no domain; they are reachable only on the
  application's internal network, from the gateway.
- Everything is on one origin so the browser sends the basic-auth
  credentials with every request, WebSockets included. A separate domain for
  the collaboration server would not get them: the browser only sends cached
  basic-auth credentials to the origin that asked for them.
- The collaboration server lives under `/oct` because Theia already uses
  `/socket.io`. `COLLABORATION_SERVER_URL=/oct` makes the Whiteboard extension
  point OCT's client at `<page origin>/oct` with socket.io path
  `/oct/socket.io` (`whiteboard-collaboration.ts`).
- `/healthz` answers `ok` without credentials and proxies nothing.
- `/whiteboard/mcp`, exactly, skips basic auth: the Whiteboard backend
  requires an agent token there instead (see
  [Authoring from agents](#authoring-from-agents)). The gateway matches the
  raw path with an exact, case-sensitive `expression`, not Caddy's `path`
  matcher: that one is case-insensitive and cleans the path first, so it
  would also have let `/Whiteboard/mcp`, `//whiteboard/mcp` and
  `/x/../whiteboard/mcp` past basic auth.
- After basic auth the gateway adds a secret header (`X-Whiteboard-Gateway`)
  and drops the password. The Whiteboard backend refuses every request other
  than `/whiteboard/mcp` without that header, and every request other than
  `/whiteboard/mcp` that carries a Bearer token, so an agent token opens
  nothing else even if a gateway rule were wrong.

Set it up:

1. In Coolify, create an Application from this Git repository and branch
   with the **Docker Compose** build pack. Set **Base Directory** to `/` and
   **Docker Compose Location** to `/spikes/theia/coolify.yaml`.
2. Give the `gateway` service a domain, e.g. `https://whiteboard.example.com:80`
   (the `:80` names the container port). Leave `whiteboard` and
   `collaboration` without a domain.
3. Under **Environment Variables**:
   - `SERVICE_PASSWORD_BASICAUTH` is generated on first load: that is the
     basic-auth password. The user is `BASIC_AUTH_USER` (default `whiteboard`).
     The gateway refuses to start with a password shorter than 16 characters.
   - `SERVICE_HEX_64_OCTJWT` is generated too; it signs collaboration logins.
   - `SERVICE_HEX_64_GATEWAY` is generated too; it is the secret header the
     gateway sets after basic auth. Both the gateway and Whiteboard read it;
     the gateway refuses to start without it.
   - `WHITEBOARD_CLONE_URLS`: space-separated git URLs cloned into the
     workspace volume on first start (default: this repository). Private
     repositories need credentials in the URL or a later manual clone.
4. Deploy. The Whiteboard image build fetches diffr and takes a few minutes.

Agents connect over HTTPS with a token of their own; see
[Authoring from agents](#authoring-from-agents).

Tested locally with the same compose file (images built here, the gateway
published on a loopback port for the test only): no page, API, `/oct` route
or WebSocket without the password; Home, a review, code peeks, the semantic
diff and the Theia editor with it; a two-user collaboration session with
edits in both directions; ports 3000 and 8100 not reachable from the host.
For agent tokens: a token created and revoked in the UI, Claude Code
connected with the `claude mcp add` line below and calling tools, the next
request after revocation refused, and the bypass cases below. Not tested on
a Coolify server itself. Base Directory `/spikes/theia` with Docker Compose
Location `/coolify.yaml` works as well as the setup above.

### Authoring from agents

On a deployment, agents use MCP over HTTPS with a token per agent:

1. In Whiteboard, run **Whiteboard: Create Agent Token…** from the command
   palette, name it after the agent (e.g. `laptop claude`) and choose
   **Read and write** or **Read only**.
2. The dialog shows the token once, with this line to copy:

   ```sh
   claude mcp add --transport http whiteboard https://whiteboard.example.com/whiteboard/mcp \
     --header "Authorization: Bearer wbat_…"
   ```

   Whiteboard keeps only a SHA-256 hash of the token; close the dialog and
   the token is gone. Create a new one if it is lost.
3. Revoke it under **Whiteboard: Manage Agent Tokens**, which lists every
   token with its access and last use. The next request with a revoked token
   is refused.

**A read-and-write token is full write access to every review on that
Whiteboard**, and read access to the code of every registered repository.
There is no per-review scope. Treat it like a password, give each agent its
own, and revoke the ones you no longer use.

How it works:

- `POST /whiteboard/mcp` is MCP Streamable HTTP, stateless, answering in
  JSON. The Theia backend checks the token, then forwards the tool calls to
  the review server with its own token, which never leaves the backend. GET
  and DELETE answer 405: there are no MCP sessions and no server-sent
  stream. Request bodies are limited to 10 MB.
- Requests without a token get 401 with `WWW-Authenticate: Bearer`. Cookies
  and basic-auth credentials are ignored there. A request whose `Origin` is
  another site gets 403. After 10 failed tokens in 5 minutes from one
  address (the first `X-Forwarded-For` hop, which a client can set itself:
  this slows down guessing, it does not stop a determined attacker; 256-bit
  secrets do), that address gets 429 for the rest of the window.
- Read-only tokens see and can call only reading tools.
- One log line per request: the token's id and name, the JSON-RPC methods,
  the tool names and outcome, and the status; never the token or arguments.
- Tokens are `wbat_<id>_<secret>`: an 8-hex-character public id and a
  32-byte random secret. They are stored in `/data/agent-tokens.json` (next
  to the review state, mode 600, written atomically) with id, name, access,
  the secret's SHA-256, and creation and revocation times. Last use goes in
  `/data/agent-tokens.usage.json`, at most once a minute per token, so
  routine requests never rewrite the token file. Both are re-read on every
  check, so a revocation from anywhere applies at once.
- Creating, listing and revoking go through `/whiteboard/admin/agent-tokens`,
  behind basic auth; requests that carry a Bearer token or come from another
  site are refused there, so an agent cannot mint or revoke tokens.
- In the container, a fallback can list and revoke, but not create: tokens
  come from the UI so they never pass through an ops shell or transcript.

  ```sh
  docker exec <whiteboard container> node \
    /opt/whiteboard/theia/whiteboard-extension/lib/node/agent-tokens-cli.js list
  docker exec <whiteboard container> node \
    /opt/whiteboard/theia/whiteboard-extension/lib/node/agent-tokens-cli.js revoke <id>
  ```

Tested through the gateway, each of these needs basic auth or is refused
(with a valid token in the request): `/whiteboard/mcp/../reviews-api`,
`/whiteboard/mcp%2f..`, `//whiteboard/mcp`, `/whiteboard//mcp`,
`/./whiteboard/mcp`, `/whiteboard/mcp/`, `/whiteboard/mcpx`,
`/Whiteboard/mcp`, `/WHITEBOARD/MCP` and `/whiteboard/mcp/x`. A
percent-encoded `/whiteboard/%6dcp` decodes to the exact path, so the gateway
lets it through; it reaches Theia under the encoded name, which refuses it
(403) for lacking the gateway header.

Without the gateway (local `compose.yaml`, or a shell on the server), agents
can also talk to the review server inside the container (with Compose, use
`docker compose -f spikes/theia/compose.yaml exec whiteboard …` instead of
`docker exec wb …`). Register checkouts by their **container** path:

```sh
docker exec wb node /opt/whiteboard/review/dist/cli.js \
  --state-dir /data/whiteboard api session_register_repository \
  '{"path":"/workspace/my-repo"}'
```

For MCP clients over stdio, use this as the server command:

```sh
docker exec -i wb node /opt/whiteboard/review/dist/cli.js --state-dir /data/whiteboard mcp
```

## Security

`compose.yaml` has **no authentication** and is only safe on `127.0.0.1`
(which is what it publishes). `coolify.yaml` puts a single shared basic-auth
account in front of everything, which keeps strangers out but is not per-user
login: everyone with the password is the same user, and the password travels
with every request, so only serve it over HTTPS (Coolify's proxy does). For
real per-user access, replace the gateway with an identity-aware proxy
(oauth2-proxy, a Keycloak gatekeeper). What the spike does do:

- The review server stays on loopback inside the container; its token never
  reaches the browser or an agent.
- Agent tokens are per agent, revocable, stored only as hashes, and accepted
  only at `/whiteboard/mcp`; see
  [Authoring from agents](#authoring-from-agents).
- The proxy refuses state-changing requests whose `Origin` does not match the
  `Host` (or `X-Forwarded-Host`) they were sent to, so other websites cannot
  write through a logged-in reverse proxy session.
- **Workspace Trust is on** (`security.workspace.trust.enabled` in
  `browser-app/package.json`). Keep it on: in a server deployment, language
  tooling running on an untrusted checkout runs on the server.
- The collaboration server's default here, simple login, accepts any name:
  the host's join approval is the only check. Behind the Coolify gateway only
  people with the basic-auth password can reach it at all; otherwise use an
  identity provider before anyone outside your machine can reach port 8100.
  Its CORS origins are limited to Theia's origin.
- A guest in a collaboration session is asked to trust the host's workspace;
  the safe answer is no (Restricted Mode).
- Only the native modules Theia needs may run install scripts
  (`allowScripts` in `package.json`).
- diffr runs inside the checkout being compared, with the container's
  environment. I did not verify whether it reads configuration or plugins
  from the checkout, so only mount checkouts you would open in an editor, and
  keep credentials diffr does not need out of the container's environment.
