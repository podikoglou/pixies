# Running Pixies with Docker

Requires Docker with Compose v2. The `docker-compose.yml` brings up two services — **pixies** and a **Caddy** reverse proxy — with one command. Caddy fronts pixies on ports 80/443, terminates TLS, and proxies to `pixies:3000` over the internal network. The pixies container publishes no host ports, so it is only reachable through Caddy.

The same compose file serves dev and production. The only difference is `DOMAIN`: `localhost` makes Caddy use its internal CA (self-signed), while a real domain makes it provision a Let's Encrypt certificate. Everything else is driven by `.env`.

## Quick start (development)

```sh
cp .env.example .env
# edit .env — at minimum set PIXIES_MODEL and PIXIES_API_KEY
docker compose up -d
```

With `DOMAIN` unset (defaults to `localhost`), the app is served by Caddy at `http://localhost` (port 80) and `https://localhost` (self-signed — browsers will warn).

## Production deployment (with Caddy + TLS)

The `docker-compose.yml` includes a Caddy reverse-proxy container that
automatically provisions Let's Encrypt certificates for your domain.

1. Point your domain to the server's IP.
2. On the server, copy and fill the env file:
   ```sh
   cp .env.example .env
   ```
   Set `DOMAIN`, `CADDY_EMAIL`, `PIXIES_MODEL`, and `PIXIES_API_KEY`.
3. Start everything:
   ```sh
   docker compose up -d
   ```

Caddy listens on ports 80 and 443 and proxies to `pixies:3000` over the internal network. The pixies service exposes no host ports in any environment; it is reached only via Caddy.

## Environment variables

Read from `.env` (copy `.env.example`).

### Required

| Variable         | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `PIXIES_MODEL`   | AI model in `provider/model-id` format (e.g. `openai/gpt-4o`) |
| `PIXIES_API_KEY` | API key for the AI provider                                   |

### Deployment (Caddy / TLS)

| Variable      | Required   | Default     | Description                                                                   |
| ------------- | ---------- | ----------- | ----------------------------------------------------------------------------- |
| `DOMAIN`      | yes (prod) | `localhost` | Domain for TLS — `localhost` → Caddy internal CA, real domain → Let's Encrypt |
| `CADDY_EMAIL` | yes (prod) | —           | Email for Let's Encrypt certificate notices                                   |

### Server

| Variable                           | Default                | Description                                                                     |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `PIXIES_HOST`                      | `0.0.0.0` in the image | Listen hostname (set by the Dockerfile and `.env.example`)                      |
| `PIXIES_PORT`                      | `3000`                 | Listen port                                                                     |
| `PIXIES_DB_FILE`                   | `pixies.db`            | SQLite path — compose sets `/app/data/pixies.db` to persist via volume          |
| `PIXIES_CACHE_SIZE`                | `50`                   | Max in-memory conversation cache                                                |
| `PIXIES_THINKING_LEVEL`            | `off`                  | AI thinking level: `off`, `low`, `medium`, `high`                               |
| `PIXIES_HTTP_RATE_LIMIT`           | `30`                   | Max POST requests per IP per window (`0` disables)                              |
| `PIXIES_HTTP_RATE_LIMIT_WINDOW_MS` | `60000`                | Per-IP HTTP rate-limit window length (ms)                                       |
| `PIXIES_TRUST_PROXY`               | `false`                | Honor `X-Forwarded-For` for client IP — set `true` behind Caddy                 |
| `PIXIES_TRUSTED_PROXY_HOPS`        | `1`                    | Rightmost trusted XFF hops for IP-spoofing prevention                           |
| `PIXIES_CONVERSATION_TOKEN_BUDGET` | `0`                    | Max tokens (input + output) per conversation across all turns (`0` = unlimited) |

### OSM clients (rate limiting, caching & timeouts)

| Variable                             | Default                                             | Description                                                 |
| ------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------- |
| `PIXIES_CONTACT_EMAIL`               | —                                                   | Contact email sent in OSM API requests                      |
| `PIXIES_OVERPASS_URL`                | `https://overpass-api.de/api/interpreter`           | Custom Overpass API endpoint                                |
| `PIXIES_OVERPASS_CONCURRENCY`        | `2`                                                 | Max concurrent in-flight Overpass requests                  |
| `PIXIES_OVERPASS_INTERVAL_CAP`       | `2`                                                 | Max Overpass requests started per interval window           |
| `PIXIES_OVERPASS_INTERVAL_MS`        | `1000`                                              | Overpass interval window length (ms)                        |
| `PIXIES_OVERPASS_TIMEOUT_MS`         | `60000`                                             | Timeout for each Overpass HTTP request (ms)                 |
| `PIXIES_NOMINATIM_URL`               | `https://nominatim.openstreetmap.org`               | Custom Nominatim endpoint                                   |
| `PIXIES_NOMINATIM_CONCURRENCY`       | `1`                                                 | Max concurrent in-flight Nominatim requests                 |
| `PIXIES_NOMINATIM_INTERVAL_CAP`      | `1`                                                 | Max Nominatim requests started per interval window          |
| `PIXIES_NOMINATIM_INTERVAL_MS`       | `1100`                                              | Nominatim interval window length (ms)                       |
| `PIXIES_NOMINATIM_TIMEOUT_MS`        | `60000`                                             | Timeout for each Nominatim HTTP request (ms)                |
| `PIXIES_NOMINATIM_CACHE_TTL_MS`      | `86400000`                                          | TTL for cached Nominatim responses (ms; `0` disables)       |
| `PIXIES_NOMINATIM_CACHE_MAX_ENTRIES` | `1000`                                              | Max cached Nominatim responses (LRU eviction; `0` disables) |
| `PIXIES_USER_AGENT`                  | `Pixies/1.0 (https://github.com/podikoglou/pixies)` | User-Agent header for OSM requests                          |

### Telemetry & alerts

| Variable                     | Default                    | Description                                                                                                                             |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PIXIES_POSTHOG_API_KEY`     | —                          | PostHog server token — ships server logs to PostHog Logs via OTel when set (off when unset; server secret, never expose to the browser) |
| `PIXIES_POSTHOG_HOST`        | `https://eu.i.posthog.com` | PostHog Cloud host for server-log shipping                                                                                              |
| `VITE_POSTHOG_KEY`           | —                          | PostHog **public** project token for the web SPA — enables browser telemetry when set (off by default)                                  |
| `VITE_POSTHOG_HOST`          | `https://app.posthog.com`  | PostHog Cloud host for the browser client                                                                                               |

> `PIXIES_WEB_DIST` and `PIXIES_MIGRATIONS_FOLDER` are baked into the image at build time (web assets and Drizzle migrations are copied during the build) and are not set via `.env`; override them only if you customize the build.

## Token budget

`PIXIES_CONVERSATION_TOKEN_BUDGET` caps the tokens a single conversation may
consume across **all** of its turns (input + output). `0` (the default) means
unlimited. The cap is per conversation — not per user or global.

Once a conversation's used tokens reach the budget, the next prompt is rejected
with **HTTP 403** and a `BudgetExceeded` body carrying `used` and `budget`. The
client surfaces this as a toast telling the user to start a new conversation;
the existing transcript stays readable.

Tokens are counted from each assistant message's `usage.totalTokens`. A
rehydrated transcript whose rows predate usage tracking (ADR-0008) undercounts
— such messages contribute `0` — so an old conversation may run slightly past
its intended cap before a rejection fires.

## Persistence

Three named volumes persist data across restarts:

- `pixies-data` — SQLite database at `/app/data/pixies.db`
- `caddy-data` — Let's Encrypt certificates and ACME state
- `caddy-config` — Caddy configuration

Conversations are stored in the SQLite database and survive restarts. A bounded in-memory cache (`PIXIES_CACHE_SIZE`, default 50) holds recently-active conversations; idle conversations are evicted from memory after 24 hours and rehydrated from the database on next access.

## Common commands

```sh
docker compose up -d            # start (builds on first run)
docker compose up -d --build    # rebuild after code changes
docker compose logs -f pixies   # follow app logs
docker compose down             # stop (keeps volumes)
```
