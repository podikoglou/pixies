# Docker

## Quick start (development)

```sh
cp .env.example .env
# edit .env — at minimum set PIXIES_MODEL and PIXIES_API_KEY
docker compose up -d
```

Open `http://localhost:3000`.

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

Caddy listens on ports 80 and 443 and proxies to `pixies:3000`. No ports need
to be exposed directly for the pixies service in production.



## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PIXIES_MODEL` | yes | — | AI model in `provider/model-id` format (e.g. `openai/gpt-4o`) |
| `PIXIES_API_KEY` | yes | — | API key for the AI provider |
| `DOMAIN` | yes (prod) | `localhost` | Domain for TLS (passed to Caddy) |
| `CADDY_EMAIL` | yes (prod) | — | Email for Let's Encrypt certificate notices |
| `PIXIES_HOST` | no | `127.0.0.1` | Listen hostname (set to `0.0.0.0` inside Docker) |
| `PIXIES_PORT` | no | `3000` | Listen port |
| `PIXIES_DB_FILE` | no | `pixies.db` | SQLite database path (set to `/app/data/pixies.db` in compose to persist via volume) |
| `PIXIES_CACHE_SIZE` | no | `50` | Max in-memory conversation cache |
| `PIXIES_THINKING_LEVEL` | no | `off` | AI thinking level: `off`, `low`, `medium`, `high` |
| `PIXIES_HTTP_RATE_LIMIT` | no | `30` | Max POST requests per IP per window (`0` disables) |
| `PIXIES_HTTP_RATE_LIMIT_WINDOW_MS` | no | `60000` | Per-IP HTTP rate-limit window length (ms) |
| `PIXIES_CONTACT_EMAIL` | no | — | Contact email sent in OSM API requests |
| `PIXIES_OVERPASS_URL` | no | `https://overpass-api.de/api/interpreter` | Custom Overpass API endpoint |
| `PIXIES_OVERPASS_CONCURRENCY` | no | `2` | Max concurrent in-flight Overpass requests |
| `PIXIES_OVERPASS_INTERVAL_CAP` | no | `2` | Max Overpass requests started per interval window |
| `PIXIES_OVERPASS_INTERVAL_MS` | no | `1000` | Overpass interval window length (ms) |
| `PIXIES_NOMINATIM_URL` | no | `https://nominatim.openstreetmap.org` | Custom Nominatim endpoint |
| `PIXIES_NOMINATIM_CONCURRENCY` | no | `1` | Max concurrent in-flight Nominatim requests |
| `PIXIES_NOMINATIM_INTERVAL_CAP` | no | `1` | Max Nominatim requests started per interval window |
| `PIXIES_NOMINATIM_INTERVAL_MS` | no | `1100` | Nominatim interval window length (ms) |
| `PIXIES_USER_AGENT` | no | `Pixies/1.0 (https://github.com/podikoglou/pixies)` | User-Agent header for OSM requests |
| `PIXIES_TRUST_PROXY` | no | `false` | Honor `X-Forwarded-For` for client IP — set `true` behind Caddy/Nginx |

## Persistence

Two named volumes persist data across restarts:
- `pixies-data` — SQLite database at `/app/data/pixies.db`
- `caddy-data` — Let's Encrypt certificates and ACME state
- `caddy-config` — Caddy configuration

## Rebuild after code changes

```sh
docker compose up -d --build
```
