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
| Diff tab | Changed-file list; each file opens in Theia's own read-only diff editor. |
| "Reveal in editor" / "Open diff" from the canvas | Opens Theia editor tabs. |
| Agents authoring reviews | `whiteboard api` / `whiteboard mcp` against the server in the container (see below). |
| Container | Multi-stage image; the review server runs as the unprivileged `node` user. |

## What does not (yet)

These are the gaps between this spike and the Theia plan, roughly in the order
they would need to be closed:

- **No login and no users.** Anyone who can reach the port can read and write
  every review. See [Security](#security).
- **No syntax highlighting.** Theia ships no TextMate grammars by default; a
  real build adds `@theia/plugin-ext` plus the built-in VS Code language
  extensions (or Open VSX equivalents).
- **Diff view is a file list**, not Code-OSS's in-canvas multi-diff widget
  (`ReviewDiffViewService`), and there is no viewed/progress tracking in it.
- **No structural (semantic) diff.** `diffr` is not fetched into the image
  and `structuralDiffEnabled` is off.
- **Desktop-only features are stubbed:** the tutorial, sharing (the share
  account endpoint 404s), bug reports, the source-tree tab, settings pages and
  the Welcome/install flow. Canvas UI telemetry is answered by the proxy with
  `204` and never leaves the container.
- **Home polls** every 5 s. An open review does update live: agent edits
  arrive over the canvas's own `/watch` stream through the proxy.
- **One review server per container.** The server is single-process by design
  (a file lock per state directory), so this is one shared workspace, not
  per-user isolation.

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

Source layout:

- `whiteboard-extension/src/node`: the backend contribution, review server
  process, streaming proxy, and canvas loader generation.
- `whiteboard-extension/src/browser`: the widget, the canvas bridge (inline
  editors, diff view, verbs, theme), the `whiteboard-source:` resource
  resolver, and commands (**View → Whiteboard**, **Whiteboard: Open Review by
  ID…**).
- `browser-app`: the Theia application (browser target, Theia 1.75).

## Run it locally

Needs Node 24 and pnpm 11 (the repository's toolchain).

```sh
# From the repository root: build the review runtime and the canvas.
pnpm install
pnpm build

# Build and start the Theia app.
cd spikes/theia
npm ci
npm run build
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

or `WHITEBOARD_WORKSPACE=/path/to/checkouts docker compose -f spikes/theia/compose.yaml up --build`.

- `/data` holds the review database and Theia settings; keep it on a volume.
- `/workspace` holds the git checkouts reviews point at. They must be readable
  by uid 1000 (the image's `node` user).
- The default runtime image is `node:24-bookworm-slim` plus git. Pass
  `--build-arg RUNTIME_IMAGE=node:24-bookworm` to skip the apt step (larger
  image, which already includes git).
- Behind a TLS-intercepting proxy, pass its CA with
  `--secret id=ca,src=/path/to/ca.pem`.

### Authoring from agents

Agents talk to the review server inside the container (with Compose, use
`docker compose -f spikes/theia/compose.yaml exec whiteboard …` instead of
`docker exec wb …`). Register checkouts by their **container** path:

```sh
docker exec wb node /opt/whiteboard/review/dist/cli.js \
  --state-dir /data/whiteboard api session_register_repository \
  '{"path":"/workspace/my-repo"}'
```

For MCP clients, use this as the server command:

```sh
docker exec -i wb node /opt/whiteboard/review/dist/cli.js --state-dir /data/whiteboard mcp
```

## Security

This spike has **no authentication**. It is only safe on `127.0.0.1` (which is
what `compose.yaml` publishes) or behind an authenticating reverse proxy
(for example oauth2-proxy or a Keycloak gatekeeper) that you trust to keep
everyone else out. What it does do:

- The review server stays on loopback inside the container; its token never
  reaches the browser.
- The proxy refuses state-changing requests whose `Origin` does not match the
  `Host` (or `X-Forwarded-Host`) they were sent to, so other websites cannot
  write through a logged-in reverse proxy session.
- **Workspace Trust is on** (`security.workspace.trust.enabled` in
  `browser-app/package.json`). Keep it on: in a server deployment, language
  tooling running on an untrusted checkout runs on the server.
- Only the native modules Theia needs may run install scripts
  (`allowScripts` in `package.json`).
