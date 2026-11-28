# Opie as a hub (docs/hub.md): the bridge headless on Linux (arm64 or x86_64), phones and computers as its screens.
#   docker build -f hub/Dockerfile -t openhouse-hub .
#   docker compose -f hub/compose.yml up -d        (then: docker logs openhouse, for the settings code)
# The household's things live in /data (one volume: back it up, or turn on backups); backups go to /backups.
FROM node:22-bookworm-slim AS build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY chat/package.json chat/package-lock.json chat/
RUN cd chat && npm ci --no-audit --no-fund
COPY webapp/package.json webapp/package-lock.json webapp/
RUN cd webapp && npm ci --no-audit --no-fund
COPY . .
RUN hub/build.sh && rm -rf chat/node_modules bridge/test bridge/fixtures

FROM node:22-bookworm-slim
# git: the apps' history (undo). curl: hub/owner-code.sh. tini: signals to the hub's two processes.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates curl procps tini \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man \
 && git config --system user.name Display && git config --system user.email display@localhost \
 && git config --system --add safe.directory '*'
WORKDIR /opt/openhouse
COPY --from=build /src/bridge bridge
COPY --from=build /src/webapp webapp
COPY --from=build /src/defaults defaults
COPY --from=build /src/device device
COPY --from=build /src/hub hub
COPY --from=build /src/chat/live chat/live
# The screen client bridge/satellite.js loads (hub/start.sh copies these three beside the bridge).
COPY --from=build /src/chat/src/screen-client.js /src/chat/src/seal.js /src/chat/src/relay-client.js chat/src/
COPY --from=build /src/runtime/hub-voice runtime/hub-voice
ENV OPENHOUSE_DATA=/data OPENHOUSE_CODE_DIR=/opt/openhouse OPENHOUSE_INSTALL=docker NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8788 8789
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD curl -fsS -o /dev/null http://127.0.0.1:8788/hub/ || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/openhouse/hub/start.sh"]
