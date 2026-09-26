# Whiteboard in Eclipse Theia, served to browsers. Build from the repository root:
#
#   docker build -f spikes/theia/Dockerfile -t whiteboard-theia .
#
# See spikes/theia/README.md before exposing the port: the spike has no login.

# node:24-bookworm (full) already has git; slim needs it installed below.
ARG RUNTIME_IMAGE=node:24-bookworm-slim

FROM node:24-bookworm AS build
ENV CI=true DO_NOT_TRACK=1
# Optional CA bundle for TLS-intercepting proxies:
#   docker build --secret id=ca,src=/path/to/ca.pem ...
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then cp /run/secrets/ca /usr/local/share/ca-certificates/build-ca.crt && update-ca-certificates; fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm install --global corepack@latest && corepack enable

WORKDIR /src
COPY . .

# The review runtime (CLI + headless server) and the canvas bundle, built with
# the repository's own toolchain, then reduced to production dependencies.
RUN pnpm install --frozen-lockfile \
      --filter "@dev.fast/review..." --filter "@dev.fast/review-canvas..." \
 && pnpm --filter "@dev.fast/review..." --filter "@dev.fast/review-canvas..." build \
 && pnpm --config.inject-workspace-packages=true --filter @dev.fast/review deploy --prod /out/review \
 && cp -r packages/review/app/dist/desktop /out/canvas

# diffr, the semantic diff engine behind the Diff tab: a pinned, checksummed
# release binary (Linux x64 only). DIFFR=skip builds without it; the Diff tab
# then falls back to the plain file list.
ARG DIFFR=required
RUN if [ "$DIFFR" != skip ]; then \
      pnpm --filter @dev.fast/review run ensure:diffr --required \
      && mkdir -p /out/review/bin && cp packages/review/bin/diffr /out/review/bin/diffr; \
    fi

# The Theia app. Only the approved native modules run install scripts.
WORKDIR /src/spikes/theia
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${RUNTIME_IMAGE}
# The review server reads sources with git.
RUN command -v git >/dev/null || { apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*; }

COPY --from=build /out/review /opt/whiteboard/review
COPY --from=build /out/canvas /opt/whiteboard/canvas
COPY --from=build /src/spikes/theia /opt/whiteboard/theia

ENV NODE_ENV=production \
    WHITEBOARD_REVIEW_CLI=/opt/whiteboard/review/dist/cli.js \
    WHITEBOARD_CANVAS_DIR=/opt/whiteboard/canvas \
    WHITEBOARD_STATE_DIR=/data/whiteboard \
    WHITEBOARD_HOST=0.0.0.0 \
    PORT=3000 \
    DO_NOT_TRACK=1 \
    HOME=/data

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace
USER node
WORKDIR /opt/whiteboard/theia/browser-app
VOLUME ["/data"]
EXPOSE 3000
COPY --chmod=755 spikes/theia/docker-entrypoint.sh /usr/local/bin/whiteboard-theia
CMD ["whiteboard-theia"]
