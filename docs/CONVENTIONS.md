# Code conventions

All source files use kebab-case naming (e.g. `chat-reducer.ts`, `use-chat.ts`).

## Comments

- JSDoc on every export.
- Inline comments segment function bodies by semantic purpose.
- Carry *why*, not narration (`// increment i` is noise).
- Prefer a named helper over a section-comment when the block has a single concern.

## Icons

Source animated icons from [pqoqubbw/icons](https://github.com/pqoqubbw/icons) —
adapt the closest original into `@/components/icons/*` (each file carries its MIT
provenance). Static icons use [`lucide-react`](https://lucide.dev). Don't
hand-roll a raw SVG. The component pattern — `forwardRef`, motion variants,
`cn()`, `displayName`, the barrel re-export — is visible in any one file in that
directory; read it, don't restate it here.

## UI components

Source new components from [9ui.dev](https://9ui.dev) first (LLM-friendly
catalog: <https://www.9ui.dev/llms.txt>); adapted copies live in
`@/components/ui/*`. Compose from those over custom styling. They're built on
`@base-ui/react` — see `packages/web/package.json`.

When a component's CSS selector conflicts with an animated icon's `<div>`
wrapper, override the layout with `flex` on the component rather than
abandoning it.

## Layout

Keep layouts as simple as possible. Avoid nested wrapper divs, complex CSS grids,
or unnecessary container elements. Prefer inline flex with minimal padding/margin.

## Persistence

Any Drizzle column declared as `text({ mode: "json" }).$type<T>()` MUST be
re-validated with a TypeBox `Value.Check` at its read boundary before its value
is trusted — `$type<>` is compile-time only and performs no runtime validation;
persisted JSON is untrusted. Each `$type<>` column in `schema.ts` carries a
comment naming its guard.

## Animations

For animation principles (interruptible, enter/exit, stagger, contextual icon
animations, scale on press, etc.), use the `make-interfaces-feel-better` skill.

Project-specific: use `motion` — do NOT add `framer-motion`.
