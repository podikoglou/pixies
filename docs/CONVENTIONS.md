# Code conventions

All source files use kebab-case naming (e.g. `chat-reducer.ts`, `use-chat.ts`).

## Icons

Icons come from [pqoqubbw/icons](https://github.com/pqoqubbw/icons) (lucide-animated).
All icon components follow the lucide-animated pattern:
- `"use client"` directive
- `forwardRef` with handle interface (`startAnimation`/`stopAnimation`)
- `motion` animation variants and `useAnimation` controls
- `cn()` for className merging
- `displayName` on the component
- Exported from `@/components/icons/index.ts`

Do NOT hand-roll raw SVGs or use `lucide-react` directly — always use pqoqubbw icons.

## UI components

Prefer existing shadcn UI components (`@/components/ui/*`) over custom styling.
Minimize custom CSS/Tailwind — compose from shadcn primitives.

When a shadcn component's CSS selector (e.g. `has-[>svg]` grid) conflicts with
pqoqubbw's `<div>` icon wrapper, override the layout with `flex` on the shadcn
component rather than abandoning it.

## Layout

Keep layouts as simple as possible. Avoid nested wrapper divs, complex CSS grids,
or unnecessary container elements. Prefer inline flex with minimal padding/margin.

## Animations

For animation principles (interruptible, enter/exit, stagger, contextual icon
animations, scale on press, etc.), use the `make-interfaces-feel-better` skill.

Project-specific notes not covered by the skill:
- `animate-timeline-enter` CSS class (defined in `globals.css`) for chat message
  entry — extends with `@keyframes` in `globals.css`.
- shadcn components have built-in `transition-*` micro-interactions (button
  scale on active, tooltip opacity, accordion height) — don't add custom wrappers.
- `animate-pulse` from Tailwind for cursor/loading states.
- `tw-animate-css` imported in `globals.css` for additional utilities.
- Use `motion` (not `framer-motion`). Do NOT add `framer-motion`.

## App assets

Favicon, PWA icons, and manifest live under `packages/web/public/`. Source
SVGs and the rasterization script are at `packages/web/scripts/`. To regenerate
raster PNGs after modifying source SVGs:

```sh
bun run packages/web/scripts/generate-icons.mjs
```

The `favicon.svg` uses `currentColor` with a `@media (prefers-color-scheme: dark)`
query for adaptive light/dark display. Static raster PNGs (used for PWA icons)
use an opaque `#fafafa` background with baked `#262626` stroke — no media query.
