# pixies

OSM-querying AI agent: a terminal chat built on `@earendil-works/pi-tui` that answers natural-language place questions via OpenStreetMap data — Overpass for feature queries, Nominatim for geocoding.

## Running

- `npm start` — run the TUI from source via `tsx` (no build step).
- `npm run typecheck` — `tsc --noEmit`. Imports use `.ts` extensions (`allowImportingTsExtensions`).

## pi-tui contract

The TUI is component-based. Every component implements `render(width): string[]` where **each returned line must not exceed `width`** — pass long lines through `truncateToWidth()` from the library. Components that change state must call `tui.requestRender()` to schedule a repaint; animated components (spinners) drive renders off a `setInterval` they clear on completion.

Reference checkout of pi (tui + agent-core + coding-agent) lives at `~/.reference/pi`. Crib idioms from `packages/coding-agent/src/modes/interactive/` and `packages/tui/test/chat-simple.ts` rather than reinventing.

## Testing TUI changes

The app needs a real TTY (raw-mode stdin). `npm start` in an interactive terminal works; for automated smoke tests, drive it through a PTY — `script(1)` boots it, and python's `pty.fork()` lets you type keystrokes and capture rendered output.

## Styling

Colors and text styling flow through the `c.*` palette and the markdown/editor themes in `src/theme.ts`. Add new roles there rather than calling `chalk` ad-hoc, so the look stays consistent.
