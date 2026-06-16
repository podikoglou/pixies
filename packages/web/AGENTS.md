# @pixies/web

React SPA — the primary chat interface.

In dev, the Vite server proxies `/conversations` and `/health` to
`localhost:3000`. The server must be running separately
(`bun run dev:server` from root).

## App assets

Favicon, PWA icons, and manifest live under `public/`. Source SVGs and the
rasterization script are at `scripts/`. Regenerate raster PNGs with:

```sh
bun run scripts/generate-icons.mjs
```
