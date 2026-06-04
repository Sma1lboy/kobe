---
"@sma1lboy/kobe": patch
---

Make `kobe api` a self-describing, full-lifecycle control surface; add `kobe skill install`.

- **`kobe api` — full task CRUD.** The old six verbs become eighteen: alongside a richer `add` (title, branch, base-branch, vendor, status, pin, optional first prompt), `fan-out`, `send`, `get-task`, `collect`, and `list`, the API now exposes the whole task lifecycle the daemon already supported — `rename`, `set-branch`, `set-vendor`, `set-status`, `archive`, `pin`, `set-active`, `ensure-worktree`, `delete`, `adopt`, `discover-adoptable`. A declarative verb table is the single source of truth driving help, schema, and flag validation (required / enum / unknown-flag rejection). `spawn-task` stays as an `add` alias.

- **Leveled, context-friendly exploration.** `kobe api schema` returns a COMPACT index (groups + verb summaries, no flags) so an agent surveys the surface cheaply, then drills in with `kobe api schema --verb <name>` (one verb's full detail), `--group <g>`, or `--all` for the complete spec. Every verb also has `kobe api <verb> --help`.

- **`kobe skill install`.** A convenience wrapper that runs the agent-skills flow (`npx skills add Sma1lboy/kobe …`) for you, plus `kobe skill status` and `kobe skill command`. The skill is version-stamped now: when you upgrade kobe past the skill you installed, `kobe doctor` / `kobe skill status` / a one-time startup hint flag it as out of date and prompt a refresh. The kobe skill itself is rewritten to document the expanded API and the leveled `kobe api schema` exploration.
