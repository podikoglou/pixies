# Code Style

Tabs, double quotes, trailing commas, semicolons.

Formatter and linter are installed per package (each owns a `format`/`lint`
script scoped to `src/`); shared config lives at the repo root
(`.oxfmtrc.json`, `.oxlintrc.json`) and is picked up via nested-config walk-up.
