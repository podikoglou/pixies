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

1. Point your domain (e.g. `pixies.aleep.lol`) to the server's IP.
2. On the server, copy and fill the env file:
   ```sh
   cp .env.example .env
   ```
   At minimum set `PIXIES_MODEL`, `PIXIES_API_KEY`, and `CADDY_EMAIL`.
3. Start everything:
   ```sh
   docker compose up -d
   ```

Caddy listens on ports 80 and 443 and proxies to `pixies:3000`. No ports need
to be exposed directly for the pixies service in production.

### Deploy script

A `deploy.sh` script is provided (gitignored; create it from the template or
write your own). It uses `rsync` to push code to the server and runs
`docker compose up -d --build` remotely:

```sh
./deploy.sh          # deploys to 'newbox' (default)
./deploy.sh myserver # deploys to a different SSH host
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PIXIES_MODEL` | yes | — | AI model in `provider/model-id` format (e.g. `openai/gpt-4o`) |
| `PIXIES_API_KEY` | yes | — | API key for the AI provider |
| `CADDY_EMAIL` | yes (prod) | — | Email for Let's Encrypt certificate notices |
| `PIXIES_HOST` | no | `127.0.0.1` | Listen hostname (set to `0.0.0.0` inside Docker) |
| `PIXIES_PORT` | no | `3000` | Listen port |
| `PIXIES_DB_FILE` | no | `pixies.db` | SQLite database path (set to `/app/data/pixies.db` in compose to persist via volume) |
| `PIXIES_CACHE_SIZE` | no | `50` | Max in-memory conversation cache |
| `PIXIES_THINKING_LEVEL` | no | `off` | AI thinking level |
| `PIXIES_CONTACT_EMAIL` | no | — | Contact email sent in OSM API requests |
| `PIXIES_OVERPASS_URL` | no | `https://overpass-api.de/api/interpreter` | Custom Overpass API endpoint |
| `PIXIES_NOMINATIM_URL` | no | `https://nominatim.openstreetmap.org` | Custom Nominatim endpoint |
| `PIXIES_USER_AGENT` | no | `Pixies` | User-Agent header for OSM requests |

## Persistence

Two named volumes persist data across restarts:
- `pixies-data` — SQLite database at `/app/data/pixies.db`
- `caddy-data` — Let's Encrypt certificates and ACME state
- `caddy-config` — Caddy configuration

## Rebuild after code changes

```sh
docker compose up -d --build
```
