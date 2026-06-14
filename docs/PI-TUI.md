# pi-tui contract

`@earendil-works/pi-tui` is the TUI framework. Its mental model is non-obvious; learn it before touching UI code.

## Component interface

Every visible thing is a `Component` implementing `render(width: number): string[]`. The returned array is one entry per terminal line, and **every line must fit within `width` cells** or the TUI will error out. Always pass potentially-long lines through `truncateToWidth(line, width, "")` (the third arg suppresses the ellipsis).

ANSI styles do **not** carry across lines — the TUI appends a full SGR reset at the end of each line, so reapply styles per line or use `wrapTextWithAnsi()` for wrapped multi-line styled text.

## Rendering is pull-based

Mutating component state does not repaint the screen. You must call `tui.requestRender()` to schedule a render. The TUI uses differential rendering (three strategies: first render, full clear on width change or change-above-viewport, incremental update otherwise) and wraps every update in synchronized-output (CSI 2026) so repaints are flicker-free.

This is why spinners work: they call `requestRender()` on a `setInterval` tick, and clear the interval when they finish. Any animated component must own its interval and clear it on terminal state transitions (`finish` / `fail` / `stop`), or it'll keep ticking after the user has moved on.

## Focus and input

Only one component has focus at a time (`tui.setFocus(component)`). Focused components receive `handleInput(data)` calls where `data` is the raw byte string from the terminal.

The terminal is in **raw mode** — Ctrl+C does *not* send SIGINT. Intercept it via `tui.addInputListener(...)` with `matchesKey(data, Key.ctrl("c"))` and `process.exit` yourself.

Use `matchesKey(data, Key.enter)`, `Key.up`, `Key.shift("tab")`, etc., rather than comparing bytes directly — the Kitty keyboard protocol makes raw-byte comparison brittle.

## Layout

Children of a `Container` (and of the `TUI` itself, which is the root container) are stacked top-to-bottom in insertion order. There is no flexbox; you compose fixed layouts by managing the children array. To insert a message above the editor without disturbing the editor's position, splice into `tui.children` at `children.length - 1`.

Overlays (`tui.showOverlay(component, opts)`) are the way to do dialogs, menus, and modals — they render on top without touching base children.

## Themes are not shipped

`@earendil-works/pi-tui` exports `MarkdownTheme`, `EditorTheme`, `SelectListTheme` interfaces but no default values. The pi repo keeps its defaults in `packages/tui/test/test-themes.ts` (unpublished). We vendor our own in `src/theme.ts`.

## Styling

All colors and text styling flow through `src/theme.ts`:
- `c.accent / c.muted / c.success / c.warning / c.error / c.user / c.assistant / c.bold` — the role palette, applied via `c.role(text)`.
- `markdownTheme`, `editorTheme`, `selectListTheme` — theme objects passed to pi-tui components.

**Do not call `chalk` ad-hoc in component code.** If you need a new visual role, add it to `c` in `src/theme.ts` and reference it from there. `chalk` is only imported by `theme.ts`.

Two `chalk`-specific notes:
- Construct it with `new Chalk({ level: 3 })` to force truecolor even when stdout is piped (otherwise smoke tests render grayscale).
- Never `.slice()` or substring-trim an ANSI-styled string — you'll cut mid-escape and corrupt the colors. If you must truncate, use `truncateToWidth()` which is escape-aware.

## Where to crib idioms from

The pi mono-repo is checked out read-only at `~/.reference/pi`. The most useful references:

- `packages/tui/test/chat-simple.ts` — ~130-line working chat UI with editor, markdown messages, loader, slash commands. Closest analogue to pixies.
- `packages/tui/README.md` — comprehensive API reference; read before writing new components.
- `packages/tui/src/components/loader.ts` — canonical example of an animated component (setInterval → requestRender → clear on stop).
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — the full pi coding agent's UI; shows how a real chat app composes everything (status bar, transcript container, editor, overlays, tool-execution rendering). Search this file before reinventing any UI pattern.
