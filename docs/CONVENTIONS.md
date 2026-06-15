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

Animations use the `motion` package (not `framer-motion`).

- **Icon animations** — `useAnimation` + `Variants`, triggered on hover by default
  (or programmatically via the icon's `*Handle` ref). See pqoqubbw/icons pattern.
- **Entry animations** — `animate-timeline-enter` CSS class (defined in `globals.css`)
  for chat message entry. Extend with `@keyframes` in `globals.css` if needed.
- **Micro-interactions** — shadcn components use Tailwind `transition-*` utilities
  (e.g. button scale on active, tooltip opacity, accordion height). Don't add custom
  animation wrappers for these — they're built into the shadcn components.
- **Pulse/loading** — `animate-pulse` from Tailwind for cursors and loading states.
- **`tw-animate-css`** — imported in `globals.css`, provides additional utilities.

Do NOT add `framer-motion` as a dependency.
