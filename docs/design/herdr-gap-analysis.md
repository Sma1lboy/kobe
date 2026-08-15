# Herdr gap analysis (2026-07-29)

Compared against [herdr.dev/docs](https://herdr.dev/docs/) (`refs/herdr/docs/next/website/src/content/docs/*.mdx`, English set). Purpose: map every herdr documented feature/doc to Rove: what we already have (→ document it), what we lack (→ borrow or explicitly skip).

## Doc-surface mapping

| Herdr doc | Rove status | Action |
|---|---|---|
| index / quick-start / install | README covers install + first run; no standalone install script | OK; borrow: agent-led onboarding blurb (we have the skill, README could point at it) |
| concepts | Only internal `docs/design/tasks.md` | **Wrote `docs/CONCEPTS.md`** (user-facing) |
| keyboard | `docs/KEYBINDINGS.md` exists, incl. `keybindings.yaml` customization | OK |
| configuration / config-reference | `state.json` + themes + `keybindings.yaml` exist, no unified reference | **Wrote `docs/CONFIGURATION.md`** |
| agents (supported agents, detection, labels, attach) | Engines claude/codex/copilot/kimi + custom engines; no user doc; no `rove attach` cmd | **Wrote `docs/ENGINES.md`**; borrow: direct-attach command (gap below) |
| agent-skill | `.agents/skills/kobe/SKILL.md` + `rove skill install` | OK (stronger than herdr's) |
| agent-automation | Engine hooks + plugin events + `rove api` | Covered by `docs/CLI.md` + PLUGIN-AUTHORING |
| integrations | Hook adapters auto-installed for claude/codex | Covered in `docs/ENGINES.md` |
| session-state | PTY host survives TUI/daemon restart; resume exists; no dedicated doc | **Wrote `docs/SESSIONS.md`** ("what survives" matrix, borrowed format) |
| persistence-remote | `experimental.remoteProjects` phases 1-5 landed, engine-over-SSH regressed (see `remote-topology-status.md`) | Not documented as shipped; see gaps |
| socket-api | `docs/design/cli-api.md` is historical; `rove api schema` is source of truth | **Wrote `docs/CLI.md`** (CLI + API reference, schema-first) |
| cli-reference | Lives in `src/cli/usage.ts` only | **Wrote `docs/CLI.md`** |
| plugins | `docs/PLUGIN-AUTHORING.md` + typed SDK | OK (stronger: typed SDK) |
| marketplace | GitHub topic `kobe-plugin` + `rove plugin search` + landing page | OK (same zero-infra model, independently built) |
| how-to-work | none | Folded into `docs/CONCEPTS.md` workflows section |
| troubleshooting | `docs/TROUBLESHOOTING.md` exists (clipboard/OSC52 depth) | OK; expand as symptoms accrue |
| windows-beta | n/a (macOS/Linux only) | Skip |

## Feature gaps worth borrowing (re-audited 2026-07-29 against code)

The first version of this list assumed gaps that turned out to be implemented-but-undocumented. Status below is code-verified; the docs written from this analysis now cover the "already have" items.

1. **Direct attach to one task's terminal** (`herdr agent attach <name>`): **genuine gap.** No `rove attach` exists; relaunching `rove` reattaches everything, and `rove api read-output` is the scripted "look at one task" recipe. A single-task attach client would serve quick-check and phone-over-SSH use; the PTY host architecture already supports pure attach clients.
2. **Remote thin client** (`herdr --remote <host>`): **genuine gap.** Rove's remote answers today: SSH into the host and run rove there (works: daemon + PTY host live remote, OSC52/OSC9 ride back), or `rove add --remote` (experimental, SSH-exec worktrees). No local-rendering client streaming a remote daemon (daemon transport is unix-socket only).
3. **Agent state detection**: **already have it, now documented** (`docs/ENGINES.md` §Activity state detection): three layers: hooks (authoritative, `needs_input` is hook-only) → transcript turn detectors (claude/codex) → quiescence/mtime fallback, with a ~10-min stale-badge watchdog. Herdr's remotely-updatable TOML screen manifests would only add: needs-input for hook-less engines, and detection-rule updates without a release. Weaker borrow than it looked. **Update 2026-08-14: the arbitration MODEL itself is now adopted** — the daemon's per-tab activity record keeps one slot per source (hook / observed) with a single pure `recomputeTabActivity` deciding the effective state (`activity-arbitrate.ts`; see `docs/design/engine-internals.md` §Activity state detection).
4. **In-app keymap help**: **already have** (`F1` / `?`, live localized keymap). Borrow the filter interaction (`/` to narrow), a small win.
5. **Self-update**: **already have**. `rove update [version|list|dry-run]`, daemon-side npm version check broadcast to clients, sidebar `u` Update page, breaking-version reset gate. Genuinely missing vs herdr: **release channels** (preview vs stable), cheap to add since releases are tags. Live handoff on update is mostly inherent: the PTY host already survives daemon restarts.
6. **Sidebar layout**: **already have** runtime splits (`ctrl+\` / `ctrl+=`), reorder (Move mode), zen mode, persisted tab/split state. Fixed 24-cell sidebar, no pane-size config. Herdr's declarative `layout.export/apply` only matters if Rove outgrows flex-ratio splits.
7. **Public docs site**: **done** (2026-07-29). `packages/kobe-docs`, Fumadocs (Next.js static export), content synced from `docs/` (same prepare-docs pattern as herdr). Not yet deployed/versioned/trilingual.
8. **Sidebar metadata tokens / plugin-owned row fields** (`$name` tokens, `report-metadata`): **genuine gap.** Plugin SDK exposes events/panes/settings/keybindings, but sidebar rows are engine-owned with no plugin or user template hook. Borrow if plugins ask for custom row fields.

## Mouse / notifications (not gaps)

Both are already broad and were under-documented rather than missing: full-mouse TUI (click-focus everywhere, wheel with native emulator semantics, drag selection, shift-drag bypass) and a three-signal notification surface (OSC 9 desktop notifications that ride SSH, bundled `pulse.wav` + BEL fallback, 4.5 s toasts, unread dots, cross-task attention inbox via `prefix+i` / `F7`, `rove api notify` for scripts). Covered in `docs/TROUBLESHOOTING.md`, `docs/CONFIGURATION.md`, and `docs/KEYBINDINGS.md`.

## Deliberate skips

- **Named sessions / workspaces-as-namespaces**: Rove's task list is already the namespace; herdr's three-level workspace/tab/pane model solves a problem Rove doesn't have.
- **Mouse-first pane management, drag borders, right-click menus**: herdr is a multiplexer; Rove's layout is fixed flex panes. Mouse support exists for click/scroll; multiplexer-style pane surgery is out of scope.
- **Prefix-mode copy mode with tmux motions**: Rove relies on the embedded terminal's own scrollback/selection; revisit only if users ask.
- **Windows/ConPTY**: no Windows support planned.

## Docs written from this analysis

- `docs/CONCEPTS.md`: task model, daemon/PTY-host/TUI split, workflows
- `docs/CONFIGURATION.md`: `state.json` keys, themes, `keybindings.yaml`, notifications
- `docs/ENGINES.md`: supported engines, detection, hooks, custom engines, resume
- `docs/SESSIONS.md`: persistence "what survives" matrix, detach/reattach, resume
- `docs/CLI.md`: consolidated CLI + `rove api` reference (points at `rove api schema` as source of truth)
