# Docker

## Quick start

```sh
cp .env.example .env
# edit .env — at minimum set PIXIES_MODEL and PIXIES_API_KEY
docker compose up -d
```

Open `http://localhost:3000`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PIXIES_MODEL` | yes | — | AI model in `provider/model-id` format (e.g. `openai/gpt-4o`) |
| `PIXIES_API_KEY` | yes | — | API key for the AI provider |
| `PIXIES_HOST` | no | `127.0.0.1` | Listen hostname (set to `0.0.0.0` inside Docker) |
| `PIXIES_PORT` | no | `3000` | Listen port |
| `PIXIES_DB_FILE` | no | `pixies.db` | SQLite database path (set to `/app/data/pixies.db` in compose to persist via volume) |
| `PIXIES_CACHE_SIZE` | no | `50` | Max in-memory conversation cache |
| `PIXIES_THINKING_LEVEL` | no | `off` | AI thinking level: `off`, `low`, `medium`, `high` |
| `PIXIES_CONTACT_EMAIL` | no | — | Contact email sent in OSM API requests |
| `PIXIES_OVERPASS_URL` | no | `https://overpass-api.de/api/interpreter` | Custom Overpass API endpoint |
| `PIXIES_NOMINATIM_URL` | no | `https://nominatim.openstreetmap.org` | Custom Nominatim endpoint |
| `PIXIES_USER_AGENT` | no | `Pixies` | User-Agent header for OSM requests |

## Persistence

`docker compose.yml` mounts a named volume at `/app/data` and sets `PIXIES_DB_FILE=/app/data/pixies.db`. Conversations survive container restarts and rebuilds.

## Rebuild after code changes

```sh
docker compose up -d --build
```
