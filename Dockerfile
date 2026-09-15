# Build the static site, then serve it with Bun in a separate runtime image.
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# Public metadata is configured at build time.
ARG PUBLIC_SITE_URL=http://localhost:3000
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL
RUN npm run build

FROM oven/bun:1-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 GLOSSARAY_PUBLIC_DIR=/app/public

COPY server/package.json ./
COPY server/src ./src
COPY --from=web /src/web/dist ./public

# Bun's image ships a non-root `bun` user; use it.
# tini as PID 1 reaps orphaned child processes.
RUN apk add --no-cache tini
USER bun
EXPOSE 3000

# Touches no provider on purpose: a health check that fails when Google is down
# would get the container restarted, which fixes nothing.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
