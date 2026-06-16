FROM oven/bun:1 AS build-web
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/tui/package.json ./packages/tui/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
COPY packages/web ./packages/web
COPY packages/core ./packages/core
COPY tsconfig.base.json tsconfig.json ./
RUN cd packages/web && bunx --bun vite build

FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/tui/package.json ./packages/tui/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts
COPY packages/core ./packages/core
COPY packages/server ./packages/server
COPY --from=build-web /app/packages/web/dist ./packages/web/dist
COPY drizzle ./drizzle
RUN mkdir -p /app/data && chown bun:bun /app/data
ENV PIXIES_HOST=0.0.0.0
EXPOSE 3000
USER bun
CMD ["bun", "run", "packages/server/src/index.ts"]
