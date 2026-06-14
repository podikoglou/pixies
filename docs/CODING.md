# Coding Conventions

## Pre-commit hook

A `lefthook` pre-commit hook runs piped **format → typecheck → lint** and stops
on the first failure. Formatting uses `stage_fixed`, so oxfmt's changes are
re-staged into the commit automatically. typecheck runs unconditionally;
format/lint only touch staged JS/TS files. Skip the hook with `--no-verify` or
`LEFTHOOK=0`.
