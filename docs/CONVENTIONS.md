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
