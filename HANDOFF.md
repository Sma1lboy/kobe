# Handoff — kobe (post-0.2.x polish wave)

> Written 2026-05-10 at the end of a long polish session that shipped 0.2.0 → 0.2.1 → 0.2.2.
> Last refreshed 2026-05-10 after the permission-mode revision (KOB-17) and **two architecture reviews** (AI-friendliness + depth-lens) both awaiting Jackson's call.
> Prior handoffs:
>   - [`docs/HANDOFF-v1.md`](./docs/HANDOFF-v1.md) — Phase 0 mission + framing.
>   - [`docs/HANDOFF-v2.md`](./docs/HANDOFF-v2.md) — Wave 3 → 4 transition (5-pane TUI shipped).
>
> THIS file: where the binary stands at v0.2.2 (with one [Unreleased] CHANGELOG bullet pending the next cut), the research that drove the recent decisions, and what's open.

---

## Read first (in this order)

1. **`CLAUDE.md`** — operating model, hard rules. Especially the "no delete without consent" rule.
2. **`docs/DESIGN.md`** — design philosophy + state-ownership conventions.
3. **`docs/PLAN.md`** — Phase 0 → 1 wave plan. Phase 1 closed at G4 (shipped as `@sma1lboy/kobe@0.1.0`); v0.2.x is post-G4 polish.
4. **`docs/KEYBINDINGS.md`** — pane-scope rules + chord-decision log. Read **before** adding/moving any chord. The Decision log section in particular records why we rejected ctrl+digit / alt+digit / ctrl+shift+digit.
5. **`docs/HARNESS.md`** — agent self-test contract.
6. **`memory/MEMORY.md`** — load-bearing per-session learnings.

---

## State of the binary at v0.2.2

```
┌──────────────────────────────────────────────────────────────────────┐
│ KobeCode v0.2.2                                  [PR] Create PR      │  TopBar
├──────────┬─────────────────────────────────┬─────────────────────────┤
│ h TASKS  │ j WORKSPACE        kobe/branch  │ k FILES                 │
│          │ ┌──[chat]─[<file>]──[<file>]─┐ │   All  Changes  Checks  │
│ [Working │ │                            │ │   .github/              │
│  session]│ │  user/assistant/tool rows  │ │   docs/                 │
│ Archives │ │  + queued prompt rows      │ │   packages/             │
│          │ │  + thinking spinner        │ │   src/                  │
│ ● task-1 │ │                            │ ├─━━━━━━━━━━━━━━━━━━━━━━━┤
│ ○ task-2 │ │  > Ask Claude…             │ │ l TERMINAL              │
│          │ │  ┃  enter queue            │ │  per-task tmux pty      │
│          │ │  ┃  ctrl+enter steer       │ │                         │
│          │ └────────────────────────────┘ │                         │
├──────────┴─────────────────────────────────┴─────────────────────────┤
│ Chat: [ctrl+q] tasks [enter] send [shift+enter] newline …            │  StatusBar
│       … [F1] help [tab] cycle [ctrl+hjkl] focus                      │
└──────────────────────────────────────────────────────────────────────┘
```

Pane focus uses **`ctrl+hjkl`** (h=tasks, j=workspace, k=files, l=terminal). The bold ordinal letter on each pane title shows the chord.

The five major user-visible additions since v0.1.x:

1. **Mid-stream queue + steer** — typing while a turn streams. Plain enter queues; ctrl+enter interrupts the in-flight subprocess and dispatches the new prompt against the same session id. Drain serialises through a `draining` lock; orchestrator buffers `done`/`error` until engine cleanup completes so `SessionRegistry: duplicate sessionId` and `tasks.json.tmp` rename races can't fire on consecutive turns.
2. **Pending approval/question pickers lifted into the composer slot** — ExitPlanMode and AskUserQuestion render as the bottom-of-chat input while pending; once submitted, the row drops back into the transcript as a resolved entry.
3. **Settings dialog two-level keyboard nav** — sidebar level (j/k cycles General/Dev) vs body level (j/k cycles theme rows + transparent-bg toggle + Dev's Reset button), h/l switch level. Every body row reachable from the keyboard.
4. **User-installable themes** under `~/.kobe/themes/` + user-pickable focus-accent color slot.
5. **Permission cycler is a two-mode toggle: `default` ↔ `plan`** (revised 2026-05-10 in commit `41e1f74`, KOB-17, lives under `[Unreleased]` in CHANGELOG until the next cut). kobe's `default` is the trusted-bypass mode — the engine maps it to claude-code's `bypassPermissions` at spawn time. `acceptEdits` is meaningless in `claude -p` (no interactive permission protocol), so it's gone from the cycle and from the `PermissionMode` type union. Persisted state with the legacy values (`acceptEdits` / `bypassPermissions` / `auto` / `dontAsk`) loads as `default`. Composer footer renders the `plan mode` badge only — default has no badge.

All four pane titles align (paddingTop=1, paddingLeft=2). Modals cap at viewport height with internal scroll for long content; the `▌` focus marker was dropped (the bold focus-accent ordinal does that job).

---

## Research findings that drove recent decisions

When I had to make a judgment call I delegated research to subagents. The decisions land in code; the *why* behind each lands here.

### 1. Pane focus chord — why `ctrl+hjkl` over `ctrl+1..4` / `alt+1..4`

Iterated through three candidates. Full decision log in [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) "Decision log: pane focus chord."

- **`ctrl+1..4`** — VSCode/iTerm muscle memory. Killed by terminal-layer reality: legacy mode doesn't propagate the ctrl modifier on digit keys (the byte the app receives is just `1`). Fixing that needs CSI-u / kitty keyboard support, AND tmux extended-keys, AND iTerm2 has a known quirk where ctrl+1 / ctrl+9 / ctrl+0 silently fall through to bare digit bytes even with CSI-u enabled (only ctrl+2..8 emit the proper sequence).
- **`alt+1..4`** — alt+digit produces a stable two-byte ESC-sequence in legacy mode, so it works regardless of CSI-u. Killed because macOS launchers (Raycast, Karabiner, Alfred) commonly intercept Option+digit globally before the byte reaches the terminal.
- **`ctrl+hjkl`** — final pick. ctrl+letter chords map to stable C0 control bytes (ctrl+h=BS, ctrl+j=LF, ctrl+k=VT, ctrl+l=FF), every terminal sends them without protocol negotiation. Conflict with editor commands (ctrl+h=backspace etc.) is OK because pressing the chord moves focus AWAY from the input that would consume it — by the time the byte reaches the textarea, focus has already left. Required moving `palette.open` from `ctrl+k` to `ctrl+p` / `cmd+p`.

**Lesson recorded in `feedback_keybinding_boundaries.md` memory**: prefer ctrl+letter over ctrl+digit / alt+digit / cmd+digit. Letters Just Work; digits need protocol upgrades; non-ctrl modifiers get hijacked by user-space launchers.

### 2. Default model resolution — what claude-code does, what opcode does, what kobe does

Researched both refs to figure out where the default model comes from.

- **claude-code** (`refs/claude-code/src/utils/model/model.ts:getUserSpecifiedModelSetting()`): resolution order is `/model` runtime override → `--model` CLI flag → `ANTHROPIC_MODEL` env var → `~/.claude/settings.json`'s top-level `model` key. The `[1m]` suffix syntax (`claude-opus-4-7[1m]`) is part of the model id, parsed by `parseUserSpecifiedModel()` to extract the 1M-context flag.
- **opcode** (`refs/opcode/src-tauri/src/commands/claude.rs:757-768`): does NOT read settings. The frontend passes `model: String` explicitly to the Tauri command on every spawn. No `~/.claude/settings.json` integration.
- **kobe (current)**: `Task.model` (per-task pin) → `~/.claude/settings.json`'s `model` key → hardcoded `FALLBACK_DEFAULT_MODEL_ID = "claude-opus-4-7[1m]"`. Mirrors claude-code's ordering. Reader at [`packages/kobe/src/tui/panes/chat/composer/claude-settings.ts`](./packages/kobe/src/tui/panes/chat/composer/claude-settings.ts). Orchestrator forwards the resolved id via `--model` on every spawn.

Picker entries also added: `opus 4.7 (1M)`, `sonnet 4.6 (1M)`. Same `[1m]` suffix syntax as claude-code.

### 3. Permission gating in `claude -p` mode — opcode's answer is "skip"

When a tool hits a permission gate (e.g. reading `~/.zshrc` from a worktree cwd), claude-code in `-p` mode has no interactive permission protocol — there is no popup, no approval event in stream-json, no built-in approve/deny UI. The pragmatic answers are:

- **opcode**: spawns with `--dangerously-skip-permissions` universally. Every gate is bypassed, model sees no denials. Verified: `refs/opcode/src-tauri/src/commands/claude.rs:757-768` and `web_server.rs:486-495` both add the flag unconditionally. opcode's "permission" UI you might find by grepping is for swarm leader/worker coordination — unrelated to subprocess gates.
- **kobe v0.2.2**: Exposed `bypassPermissions` as a 4th step in the shift+tab cycler (`default → acceptEdits → plan → bypass → default`). User opt-in per task. *Revised in [Unreleased] / KOB-17* — see next bullet.
- **kobe [Unreleased] (KOB-17, commit `41e1f74`)**: kobe's `default` IS opcode's choice. The engine maps `default` (and any non-`plan` value) to `--permission-mode bypassPermissions` at spawn. Rationale: in v0.2.2, `permissionMode=undefined/default` meant "no flag passed," which left claude in its restrictive built-in default — every cwd-boundary read prompted, every tool call hit the gate. From the user's seat that looked like "kobe doesn't have permissions wired up." Since `claude -p` has no interactive permission protocol anyway, the only useful CLI choices are "auto-deny outside cwd" (claude `default`) or "auto-approve everything" (`bypassPermissions`); kobe picked the latter. The shift+tab cycle collapsed to `default ↔ plan` (`acceptEdits` is moot in non-interactive mode).
- **The proper alternative** (not built): `--permission-prompt-tool <name>` lets claude-code delegate every tool-permission decision to a custom MCP tool. Wiring that up requires (a) a kobe-hosted MCP server implementing the permission tool, (b) registering it on every spawn, (c) routing async permission requests to a UI panel and waiting for approve/deny. ~2-3 day build. Tracked as a follow-up; not in v0.2.x scope.

### 4. Mid-stream submission modes — the queue/steer feature

claude-code's own UI implements this via a unified `commandQueue` with three priorities (`'now' / 'next' / 'later'`) — see `refs/claude-code/src/utils/messageQueueManager.ts`. kobe collapsed `'next'` into `'later'` because `claude -p` is a one-shot subprocess with no mid-tool insertion point: queueing past the in-flight turn is the only meaningful "later" semantics. `'now'` maps to kobe's `ctrl+enter` steer (kill subprocess + run new prompt against same session id); `'later'` maps to plain `enter` queue (drained on `done`).

---

## Architecture review — Jackson's pending decision (added 2026-05-10)

Jackson asked for an "AI-friendly" pass on the codebase: where does the project structure trip up agents (and humans) when reasoning about it, and what should we collapse / re-export to stop imports from flying around. Findings below; **Jackson said "记录下我等下思考"** — these are surfaced for triage, not started yet.

Findings ranked by leverage:

| # | Smell | Data | Proposed fix |
|---|---|---|---|
| 1 | **Path aliases under-used** | `tsconfig.json` declares 6 aliases (`@/`, `@tui/`, `@engine/`, `@orchestrator/`, `@types/`, `@test/`). Only **8 imports** in `src/` use them; **93 imports** still write `../../../`. | Codemod-replace relative-to-alias across `src/`. Mechanical; no behavior change; massive readability + AI-friendliness win. File moves stop breaking import chains. ~30 min. Should land as one commit + Linear bullet. |
| 2 | **`src/` reverse-imports `test/`** | `src/tui/panes/terminal/Terminal.tsx` imports `stripAnsi` from `../../../../test/behavior/screen` — production code reaching 4 levels up into the test tree. | Move `stripAnsi` (and audit for other helpers) into `src/lib/ansi.ts`. Test → src is normal; src → test is a smell. ~5 min. |
| 3 | **Inconsistent barrels + barrel-as-implementation** | Some panes have a public `index.ts` (filetree, preview, terminal); chat and sidebar don't. `src/engine/claude-code-local/index.ts` is **both a barrel AND a 296-line implementation file** — exports `class ClaudeCodeLocal` defined right inside. | Each pane gets a thin `index.ts` exposing only the public API (`Chat`, `useChatBindings`, props types). Internals (`store.ts`, `tool-banners.ts`, etc.) stay private to the pane. Move `ClaudeCodeLocal` impl out of `engine/claude-code-local/index.ts` into `local.ts`, leave index as a pure barrel. |
| 4 | **`src/tui/app.tsx` is 2021 lines, 35 imports** | One file owns the shell + all 5 dialogs (Settings, Help, Update, NewTask, ConfirmDelete) + global state plumbing + layout. | Extract dialogs into `src/tui/dialogs/*.tsx`. `app.tsx` ends up just the layout shell + provider tree. Touches `app.tsx` heavily; do AFTER #1 so import paths are stable. |
| 5 | **`src/orchestrator/core.ts` is 1544 lines** | God class: task lifecycle + event bus + worktree manager wiring + chat tab management + concurrency cap + PR flow. | Bigger surgery. Probably split into `orchestrator/{lifecycle,events,chat-tabs,pr}.ts` with a thin `Orchestrator` facade. Standalone Linear ticket. Defer until #1–#4 land. |

Recommendation order on the table: **#1 → #2 → #3 → #4 → #5**. Jackson hasn't picked yet.

### Depth-lens pass (added 2026-05-10, second review same day)

Second pass via `/improve-codebase-architecture` — Ousterhout depth lens (Module / Interface / Depth / Seam / Adapter / Leverage / Locality). Overlaps with #4 and #5 above but reframes them and adds two new candidates. Same status: surfaced for Jackson's call, **not started**.

| # | Candidate | Friction (with line refs) | Why it earns being deeper |
|---|---|---|---|
| D1 | **user-input request lifecycle smeared across 4 files** | Detect/parse/render in `src/orchestrator/core.ts:1453–1541`; pendingInput map keyed by Task only in `core.ts:289 + 785–810` (comment at 796–802 admits wrong ChatTab receives banner); state mutation in `src/tui/panes/chat/store.ts:485–548`; pending-row lift in `Chat.tsx` ~680–720; render in `MessageList.tsx:100–137`. | Textbook cross-Pane concept smear. No Module owns "Claude paused, asking user" end-to-end. A `PendingInput` Module collapsing detect + bucket + route + render-where gains real **Locality** (one place per new tool) and makes the tabId-routing bug uncompilable. Removes reliance on HTTP side-channel for `respondToInput` testing. |
| D2 | **Orchestrator god-Module — 1584 lines, ~6 concerns** | `src/orchestrator/core.ts` mixes Task CRUD + ChatTab lifecycle + `pumpEvents` (1083+) + user-input routing + `requestPR` with implicit preconditions (754–772, throws `PRPreconditionError` caller must pre-check) + `maybeRenameTempBranch` heuristics (541–590). Different change rates. Restates row #5 above. | Highest Leverage but riskiest. Splitting peels off pump (engine-shaped), PR flow (git-shaped), metadata (heuristic-shaped) — each gets its own unit-test seam without `FakeAIEngine`. `requestPR` preconditions become a typed `canRequestPR()` capability. Discuss WHICH slice peels first; depth lens prefers user-input (D1) as the cleanest extraction. |
| D3 | **`app.tsx` Shell inlines two cohesive sub-Modules** | New-task dialog state machine at `src/tui/app.tsx:308–570` (~250 lines, untested in isolation, two pickers + field-cycle + validation). Keybinding wiring at `app.tsx:885–892 + 1205–1610` — seven sequential `useBindings` calls (lines 1205, 1242, 1248, 1409, 1571, 1582, 1608) where registration order *is* the priority. Restates row #4 above. | Dialog has a clean Interface (input: repos + initial values, output: task spec). A `Keymap` Module with declared priority order has same Leverage for callers but smaller Interface to learn — "where does ctrl+t go?" answerable in one read. |
| D4 | **`KOBE_RESUME_CWD` is a load-bearing back-channel, not a typed Interface** | `core.ts:24–29` comments "load-bearing and tested below"; `engine/claude-code-local/index.ts:93` reads from env; `src/types/engine.ts` `AIEngine.resume(sessionId, prompt, opts?)` has no cwd parameter. NEW vs prior review. | Production has one adapter; tests have `FakeAIEngine`. **One adapter = hypothetical seam, two = real** — but the fake only works because env vars happen to forward. Any future adapter has no compile-time signal it must handle resume-cwd. Promote `cwd` to typed `ResumeOpts` field. Smallest/lowest-risk candidate. No ADR conflict (none exist). |

**Depth-lens ranking suggested to Jackson:** D1 (highest payoff, latent bug) → D4 (smallest/safest) → D2 (most architectural) → D3 (cleanup-shaped).

**Cross-reference with prior pass:** D2 ≈ table row 5. D3 ≈ table row 4. D1 and D4 are new (the prior pass looked at file size + import paths; this pass looked at Interface depth + Seam reality). The two reviews don't conflict — they prioritize differently and a future agent could pick from either list. Recommendation: land path-alias codemod (row 1) first regardless, then revisit.

**Vocabulary note:** No CONTEXT.md or `docs/adr/` exist yet. If any of these get picked and naming crystallizes during grilling, the `/improve-codebase-architecture` skill creates them lazily.

---

## Open follow-ups (in rough priority order)

### Single-daemon + single-TUI mode (KOB-49 follow-up, recorded 2026-05-11)

`dev:sandbox` proved the isolated-home pattern. Jackson wants the same lifecycle (start with the TUI, die with the TUI) available for production users — for "I just want to use kobe for one session, no background daemon left behind" cases.

**Decision pending — A vs B:**

| Option | Home | Trade-off |
|---|---|---|
| A. ephemeral isolated home | random `$TMPDIR/kobe-ephemeral-<pid>` | Safe, no race with prod daemon. But the task history dies with the TUI — basically dev:sandbox with a friendlier flag name. |
| B. ephemeral daemon, **prod home** | `~/.kobe` (shared) | Real tasks preserved. But same-machine prod daemon + ephemeral daemon both writing `tasks.json` race — must detect prod daemon at startup and either **attach** (don't fork a second one) or **refuse**. |

My recommendation: **B with attach-if-prod-exists**. Flag-name candidates: `--ephemeral`, `--single`, `--exclusive`. Behaviour spec:

- `kobe --ephemeral` at launch:
  1. Probe `defaultDaemonSocketPath()` — if a daemon is reachable there, just attach as a normal client. The flag becomes a no-op when a long-lived prod daemon already owns the home.
  2. Otherwise, spawn a kobed child, set up an exit hook that calls `daemon.stop` on TUI shutdown (Ctrl+C, `q`, crash via `process.on('exit')`).
  3. Pidfile + socket path stay at `~/.kobe/...` so a subsequent `kobed status` finds the right daemon.

- Edge cases to lock down before shipping:
  - **TUI crash before stop dispatches** — orphans a daemon. Add a heartbeat: if no client has been attached for >N seconds, daemon self-terminates.
  - **User kills TUI, then re-launches with `--ephemeral` while daemon is still tearing down** — collide on socket path. Reuse the kobed restart logic (poll old pid until exit, ignore EADDRINUSE during the gap).
  - **`--ephemeral` + `--home <dir>`** — flag combines cleanly; `KOBE_HOME_DIR` is already orthogonal.

Recorded; not started. Jackson called the shape but said "later."

### Other open

0. **Architecture review (above).** Jackson is thinking. Don't start without his pick. **Two passes now exist** — original AI-friendliness pass (rows 1–5) and depth-lens pass (D1–D4). Pick from either or both.
1. **Permission-prompt MCP bridge.** [Unreleased] settled for opcode-style `bypassPermissions` as kobe's `default`. Real fix is the MCP-server route described above. Tracked separately. ~2-3 day estimate.
2. **Behavior tests are local-only.** They need tmux + node-pty terminal sizing that CI can't easily provide. CI runs typecheck + unit + build only. Some tests on this machine fail due to local environment quirks (terminal resize timing, tmux extended-keys in test environment). Re-running on Jackson's machine generally passes.
3. **`extended-keys` requirement** for users who DO want ctrl+digit / CSI-u sequences (the few legitimate ctrl+digit chords in the keymap). `~/.tmux.conf` needs `set -g extended-keys on` + `set -as terminal-features 'xterm*:extkeys'`, AND iTerm2 needs profile-level "Report keys using CSI u." iTerm2's ctrl+1 quirk persists even with that. Documented in `docs/KEYBINDINGS.md`.
4. **kobe currently re-reads `~/.claude/settings.json` lazily** with a process-lifetime cache. claude-code's own `/model` command rewrites the file mid-session — kobe doesn't pick that up live. Cache invalidation is a follow-up; for now the user restarts kobe to pick up the new default.
5. **Bold leading number on chat tab chips** was removed when chat tab navigation moved from `ctrl+1..9` numeric pick to `ctrl+]` / `ctrl+[` cycle. If the user later wants positional chat-tab chord back (e.g. `alt+1..9` or some bracket-prefixed chord), the chip rendering can re-add an ordinal.

---

## Operating discipline — what the next session should preserve

- **Every keybinding decision goes through `docs/KEYBINDINGS.md`.** Add an overlap-table row when you discover a new conflict, append to the Decision log when a chord moves. The doc is small on purpose — if a section sprawls, the underlying design is probably wrong.
- **`KobeKeymap` in `packages/kobe/src/tui/context/keybindings.ts` is the single source of truth.** No chord strings outside that table; pane code uses `bindByIds({ id: handler })`.
- **CHANGELOG entries are user-facing.** Past sessions sometimes cataloged 30 atomic commits as 4 user-visible bullets — that's the right altitude. Use `[Unreleased]` while in flight, rename to `[X.Y.Z] - YYYY-MM-DD` when cutting.
- **Behavior tests are local-only**, not gating CI. Don't block on them; run them when you have a real environment, surface flaky ones to Jackson.
- **The `refs/` slot is read-only.** opcode + claude-code are research material. When you don't know how a subprocess pattern should look, port from `refs/opcode/`. When you don't know how a chat row should look, port from `refs/claude-code/`. Don't reinvent.
- **No delete without explicit user consent in the same conversation turn.** This bit a previous session — accidentally `git add -A` swept up 503 unrelated deletions. The recovery commit is in the log.

---

## Releases shipped this session

| Version | Date       | Notes                                                                      |
| ------- | ---------- | -------------------------------------------------------------------------- |
| 0.2.0   | 2026-05-10 | Queue/steer, modal viewport caps, picker-first new-task, two-level settings, user-installable themes, focus-accent setting, ctrl+hjkl pane focus. |
| 0.2.1   | 2026-05-10 | Default model from `~/.claude/settings.json`, opus 4.7 (1M) added, unified focus-blur on pane jump. |
| 0.2.2   | 2026-05-10 | `bypassPermissions` reachable via shift+tab cycler.                        |

All three published to npm + tagged on GitHub via the release workflow. CHANGELOG entries at `packages/kobe/CHANGELOG.md` are the authoritative descriptions.

---

## Mini-session log (post-v0.2.2 polish, not yet a release)

Tracked here so the next agent knows what's settled vs in flight without a fresh release tag.

### Committed to `main` since v0.2.2

- `5a7286e` `docs(changelog): unwrap soft-wraps + teach skill the no-<br> rule (KOB-13)` — CHANGELOG single-line bullets to fix GitHub release rendering.
- `41e1f74` `fix(permissions): default auto-bypasses + cycle slimmed to default ↔ plan (KOB-17)` — see Research findings §3 revision above.

### Linear cleanup (this session)

- **KOB-1** (pane focus mouse-only) → Done. Resolved by `85d087d` ctrl+hjkl in v0.2.2.
- **KOB-8** (queue + steer / 流式中断) → Done. Shipped in v0.2.0 (`d7de07d`, `0cd2a78`, `b153904`).
- **KOB-4** (permission-ask freeze, 待复现) → still open. Commented: KOB-17's default→bypass eliminates the common-path trigger; plan-mode users could still hit it. Lower urgency now.
- **KOB-7** (full keyboard workflow audit) → still open as the umbrella feature.
- **KOB-17** (this session's fix) → Done with SHA comment.

### Skills installed (this session)

- **`/handoff`** at `.claude/skills/handoff/SKILL.md` — adapted from [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips/blob/main/skills/handoff/SKILL.md). The skill that wrote this very update.

### Working-tree WIP (NOT this session — Jackson said "别人在做的")

There's substantial uncommitted work in the tree from a parallel session — multi-repo sidebar (`kind: main | task` discriminator → KOB-15), filetree git-status indicators (~300 lines), terminal/preview keys, linear skill cleanup. **Don't touch this WIP**; it's owned by another session. The handoff agent for THAT work will surface separately.
