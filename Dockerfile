# ── Build stage ──────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# No key is baked into the image. Provide it at runtime with
# RSA_PRIVATE_KEY (base64) or mount a file and set RSA_PRIVATE_KEY_PATH.
RUN mkdir -p /app/keys && chown -R node:node /app/keys && chmod 700 /app/keys
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "dist/main"]
