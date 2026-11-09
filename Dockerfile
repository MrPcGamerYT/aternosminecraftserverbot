# ============================================================
# minecraft-afk-bot — production image
#
#   docker build -t afk-bot .
#   docker run -p 5000:5000 --env-file .env afk-bot
#
# Node 20 LTS on Alpine keeps the image small; mineflayer is pure
# JavaScript, so nothing needs compiling.
# ============================================================
FROM node:20-alpine AS deps

WORKDIR /app
ENV NODE_ENV=production

# Only the manifests, so the dependency layer caches across code edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=5000 \
    NODE_OPTIONS=--unhandled-rejections=warn

# tini gives us clean SIGTERM forwarding so the bot can quit the game
# properly instead of being SIGKILLed mid-session.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js logger.js probe.js watcher.js provider.js leaveRejoin.js settings.json ./
COPY launcher_accounts.json ./

# Run as the unprivileged user that ships with the node image.
RUN mkdir -p /tmp/afk-bot-lease && chown -R node:node /app /tmp/afk-bot-lease
USER node

# The single-instance lease lives on tmpfs-free /tmp by default; pin it
# somewhere predictable so operators can mount or inspect it.
ENV BOT_LEASE_DIR=/tmp/afk-bot-lease

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/ping',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
