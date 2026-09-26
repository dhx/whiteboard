# Self-hosted Open Collaboration Tools server. Build from spikes/theia:
#
#   docker build -f oct-server/Dockerfile -t whiteboard-oct .
FROM node:24-bookworm-slim
WORKDIR /app

# npm ci needs every workspace manifest to match the lockfile.
COPY package.json package-lock.json ./
COPY oct-server/package.json oct-server/
COPY browser-app/package.json browser-app/
COPY whiteboard-extension/package.json whiteboard-extension/
# Optional CA for TLS-intercepting proxies: --secret id=ca,src=/path/to/ca.pem
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && npm ci --workspace oct-server --omit=dev --ignore-scripts --no-audit --no-fund

COPY oct-server/start.mjs oct-server/
USER node
ENV OCT_HOST=0.0.0.0
EXPOSE 8100
CMD ["node", "oct-server/start.mjs"]
