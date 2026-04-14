# syntax=docker/dockerfile:1
FROM docker.io/oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --no-save

FROM docker.io/oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json server.ts ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
USER bun
CMD ["bun", "run", "server.ts"]
