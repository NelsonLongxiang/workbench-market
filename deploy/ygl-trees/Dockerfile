FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG YGL_TREES_VERSION=0.119.0
ARG YGL_TREES_INTEGRITY=sha512-voXQXlZxAFeKiDffSfujU7JrLFfWMHHIc5SpktqE29o1/aX0tvuXSQyJW0xNrx17qqMTp0cTxn4wSGOeR5e4Cw==
ENV npm_config_update_notifier=false
COPY --chown=root:root package.json package-lock.json /opt/ygl/
WORKDIR /opt/ygl
RUN test "$(node -p 'require("./package-lock.json").packages["node_modules/ygl-trees"].version')" = "${YGL_TREES_VERSION}" \
 && test "$(node -p 'require("./package-lock.json").packages["node_modules/ygl-trees"].integrity')" = "${YGL_TREES_INTEGRITY}" \
 && npm ci --omit=dev --ignore-scripts=false \
 && mkdir -p /var/lib/ygl \
 && chown -R node:node /var/lib/ygl
COPY --chown=root:root mcp-entrypoint.sh /usr/local/bin/ygl-mcp-entrypoint
COPY --chown=root:root entrypoint.sh /usr/local/bin/ygl-sync-entrypoint
RUN chmod 0555 /usr/local/bin/ygl-mcp-entrypoint /usr/local/bin/ygl-sync-entrypoint
ENV PATH=/opt/ygl/node_modules/.bin:${PATH} YGL_HOME=/var/lib/ygl HOME=/var/lib/ygl YGL_SESSION=docker-workspace
USER node
WORKDIR /var/lib/ygl
ENTRYPOINT ["/usr/local/bin/ygl-mcp-entrypoint"]
