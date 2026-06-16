FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/tui/package.json ./packages/tui/
RUN bun install --frozen-lockfile

FROM base AS build-web
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/package.json ./package.json
COPY --from=install /app/bun.lock ./bun.lock
COPY packages/web ./packages/web
COPY packages/core/src ./packages/core/src
COPY tsconfig.base.json tsconfig.json ./
RUN bun run build:web

FROM base AS runner
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/package.json ./package.json
COPY --from=install /app/bun.lock ./bun.lock
COPY --from=install /app/packages ./packages
COPY --from=build-web /app/packages/web/dist ./packages/web/dist
COPY drizzle ./drizzle

ENV HOSTNAME=0.0.0.0
EXPOSE 3000
USER bun
CMD ["bun", "run", "--filter", "@pixies/server", "start"]
