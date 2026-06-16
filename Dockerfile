FROM oven/bun:1 AS base

FROM base AS install
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/tui/package.json ./packages/tui/
RUN bun install --frozen-lockfile

FROM base AS build-web
WORKDIR /app
COPY --from=install /app/node_modules ./node_modules
COPY packages/web ./packages/web
COPY packages/core ./packages/core
COPY tsconfig.base.json tsconfig.json ./
RUN bun --bun vite build --config packages/web/vite.config.ts --root packages/web

FROM base AS runner
WORKDIR /app

COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/package.json ./package.json
COPY --from=install /app/bun.lock ./bun.lock
COPY packages/core ./packages/core
COPY packages/server ./packages/server
COPY --from=build-web /app/packages/web/dist ./packages/web/dist
COPY drizzle ./drizzle

ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["bun", "run", "--filter", "@pixies/server", "start"]

USER bun
