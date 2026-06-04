---
"@sma1lboy/kobe": minor
---

Make `kobe api` a self-describing, full-lifecycle control surface, and add `kobe skill install`.

- **`kobe api` — full task CRUD + self-describing.** The old six verbs become eighteen: alongside `add` (now richly parameterized — title, branch, base-branch, vendor, status, pin, optional first prompt), `fan-out`, `send`, `get-task`, `collect`, and `list`, the API now exposes the whole task lifecycle the daemon already supported — `rename`, `set-branch`, `set-vendor`, `set-status`, `archive`, `pin`, `set-active`, `ensure-worktree`, `delete`, `adopt`, and `discover-adoptable`. A new `kobe api schema` prints the full machine-readable spec (every verb, flag, type, required field, enum values) so an agent can explore the surface in one call, and every verb has `kobe api <verb> --help`. A declarative verb table is the single source of truth that drives schema, help, and flag validation (required / enum / unknown-flag rejection), so the API stays consistent and discoverable. `spawn-task` keeps working as an alias of `add`.

- **`kobe skill install`.** A convenience wrapper that runs the agent-skills flow (`npx skills add Sma1lboy/kobe --skill kobe --agent claude-code`) for you, so nobody has to remember the exact invocation. `kobe skill status` reports whether it's installed and `kobe skill command [--agent NAME]` prints the underlying npx command. The kobe skill itself is rewritten to document the expanded API and point agents at `kobe api schema`.
