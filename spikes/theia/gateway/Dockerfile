# Basic-auth gateway for the Theia spike. Build from spikes/theia:
#
#   docker build -f gateway/Dockerfile -t whiteboard-gateway .
FROM caddy:2.10-alpine
COPY gateway/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 gateway/entrypoint.sh /usr/local/bin/whiteboard-gateway
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/whiteboard-gateway"]
