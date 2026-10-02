FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

# better-sqlite3 has a native module and may need a local build toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CODEX_HOME=/data/codex \
    DATABASE_PATH=/data/bot.sqlite3 \
    HOST=0.0.0.0 \
    PORT=8080 \
    PATH=/app/node_modules/.bin:$PATH

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data /workspace \
  && chown -R node:node /data /workspace /app

COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src

VOLUME ["/data"]
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/index.js"]
