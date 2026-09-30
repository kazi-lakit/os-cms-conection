# ── Stage 1: build the React client ────────────────────────────────────────────
FROM node:20-alpine AS client-build

WORKDIR /build

# Root lockfile + every workspace manifest first, so dependency layers cache
# independently of source changes (npm requires all declared workspaces to exist).
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json

RUN npm ci --no-audit --no-fund

COPY client/ client/

RUN npm run build -w client

# ── Stage 2: runtime (Node backend serving the built client) ───────────────────
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json

# Server workspace's production dependencies only (client deps are build-time).
RUN npm ci --omit=dev --no-audit --no-fund -w server \
  && npm cache clean --force

COPY server/index.js server/store.js server/

COPY --from=client-build /build/client/dist client/dist

# server/store.js writes server/.connection.json next to the server sources at
# runtime; make that writable for the unprivileged user.
RUN mkdir -p server && chown -R node:node /app/server
USER node

ENV PORT=8080
EXPOSE 8080

# dotenv loads server/.env if present; on Railway/Fly/etc set real env vars instead.
# Set BLOCKS_OS_URL / BLOCKS_IAM_URL / APP_ORIGIN at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/status" >/dev/null || exit 1

CMD ["node", "server/index.js"]
