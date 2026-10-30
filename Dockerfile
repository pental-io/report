# Pental Report: the app and its server in one image.
#
# Published for each release as ghcr.io/pental-io/report, built by
# `docker compose build` from this folder, or by hand with
# `docker build -t pental-report .`.
#
# SPDX-License-Identifier: AGPL-3.0-only

# The app is built once, on the builder's own platform: what it makes is the
# same JavaScript for every platform the image is published for.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server server
COPY web web
RUN node web/build.mjs

FROM node:22-alpine
LABEL org.opencontainers.image.title="Pental Report" \
      org.opencontainers.image.description="Free, open-source penetration test reporting you run yourself" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="Pental Limited" \
      org.opencontainers.image.url="https://pental.io/report" \
      org.opencontainers.image.source="https://github.com/pental-io/report"
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/web \
    DB_DIR=/app/db
WORKDIR /app
COPY --from=build /src/server /app/server
COPY --from=build /src/web/dist /app/web
COPY db /app/db
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "/app/server/server.js"]
