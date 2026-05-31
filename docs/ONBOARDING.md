# Onboarding & domain SOP

For new teammates (and the agents that work alongside us). Walks through
first-time setup, who owns what, and the per-domain SOP for picking up
work.

> Read [`CLAUDE.md`](../CLAUDE.md) (root + `packages/kobe/CLAUDE.md`),
> [`docs/DESIGN.md`](./DESIGN.md), [`docs/PLAN.md`](./PLAN.md),
> [`docs/HARNESS.md`](./HARNESS.md), and [`docs/LINEAR.md`](./LINEAR.md)
> first. This doc is the human-friendly index, not the source of truth.

---

## 1. First-time setup (15 min)

```bash
# 1. clone + bootstrap
git clone git@github.com:Sma1lboy/kobe.git && cd kobe
bun install

# 2. study material (gitignored — clone yours)
mkdir -p refs && cd refs
ln -s /path/to/agent-deck agent-deck   # if local; otherwise skip
git clone --depth 1 https://github.com/winfunc/opcode.git
git clone --depth 1 https://github.com/tanbiralam/claude-code.git
cd ..

# 3. typecheck + tests
bun --filter @sma1lboy/kobe typecheck
bun --filter @sma1lboy/kobe test
bun --filter @sma1lboy/kobe test:behavior   # needs node-pty for the test driver

# 4. run it
bun --filter @sma1lboy/kobe dev

# 5. local work tracking
git status --short
sed -n '1,80p' HANDOFF.md
```

If any step fails, capture it in `HANDOFF.md` or a focused repo Markdown note before fighting it.

---

## 2. Repo map

```
kobe/
├── packages/
│   ├── kobe/                      # the TUI (published as @sma1lboy/kobe)
│   │   ├── src/
│   │   │   ├── cli/               # `kobe` CLI entry
│   │   │   ├── engine/            # subprocess engine for Claude Code
│   │   │   │   └── claude-code-local/  # spawn + stream-json + JSONL
│   │   │   ├── orchestrator/      # task scheduling, state machine
│   │   │   ├── state/             # global stores (Solid signals)
│   │   │   ├── tui/
│   │   │   │   ├── app.tsx        # root pane composition
│   │   │   │   ├── context/       # keybindings, focus, theme, kv
│   │   │   │   ├── panes/
│   │   │   │   │   ├── chat/      # central content (chat + tools)
│   │   │   │   │   ├── filetree/  # left/right file tree
│   │   │   │   │   ├── preview/   # diff / preview pane
│   │   │   │   │   ├── sidebar/   # left task list (history rail)
│   │   │   │   │   └── terminal/  # embedded terminal pane
│   │   │   │   ├── component/     # shared widgets
│   │   │   │   ├── lib/           # utilities
│   │   │   │   └── ui/            # primitives (Box, Text, Button)
│   │   │   └── types/             # shared TS types
│   │   ├── test/
│   │   │   ├── behavior/          # PTY-driven end-to-end (HARNESS.md)
│   │   │   └── ...                # unit + integration
│   │   └── scripts/
│   └── branding/                  # Remotion → docs/assets/brand/
├── docs/                          # source-of-truth markdown
│   ├── ARCHITECTURE.md
│   ├── DESIGN.md
│   ├── HARNESS.md
│   ├── LINEAR.md
│   ├── ONBOARDING.md  ← you are here
│   └── PLAN.md
├── refs/                          # gitignored study repos (read-only)
├── .agents/skills/                # installed agent skills
├── .claude/skills/                # symlinks → .agents/skills/<name>
├── HANDOFF.md                     # latest session state + follow-ups
└── CLAUDE.md                      # workspace + project rules
```

---

## 3. Domain map & ownership

Loose ownership — anyone can fix any bug, but if you're starting fresh
work in an area, ping the listed owner first to avoid stomping.

| Domain | Files | Owner | Conventions |
|---|---|---|---|
| **Chat / message rendering** | `src/tui/panes/chat/` | Jackson | Match Claude Code's `src/ink/` rendering (refs/claude-code) — don't reinvent. |
| **Composer / input** | `src/tui/panes/chat/composer/`, `Composer.tsx` | Jackson | Heavy keyboard user contract: every interaction must be reachable without a mouse. |
| **Hotkeys / keybindings** | `src/tui/context/keybindings.ts` | 薯条 | Central registry (PR #5). Add new bindings here, not inline in pane code. Document chord sequences. |
| **Sidebar / task list** | `src/tui/panes/sidebar/` | Jackson | Compact task rail at 12 cells. Don't hardcode height. |
| **File tree** | `src/tui/panes/filetree/` | TBD | Look at agent-deck's file pane for layout grammar. |
| **Terminal pane** | `src/tui/panes/terminal/` | Pengyu | Isolated module — modify freely without coordinating with other panes. Cursor visibility is a known issue (KOB-2). |
| **Preview / diff** | `src/tui/panes/preview/` | Jackson | "open*" diff naming TBD — `opendiff` / `claudediff` candidates. |
| **Engine (subprocess)** | `src/engine/claude-code-local/` | Jackson | Algorithmically ported from `refs/opcode/src-tauri/.../claude.rs`. Mirror opcode's stream-json parser when extending. |
| **Orchestrator / task state** | `src/orchestrator/`, `src/state/` | Jackson | State definition recently simplified (5 states removed). Spec doc forthcoming. |
| **Worktrees** | `.claude/worktrees/`, orchestrator integration | Jackson | Always `.claude/worktrees/`, never `.kobe/worktrees/`. |
| **Behavior tests** | `test/behavior/` | Jackson | PTY driven (`docs/HARNESS.md`). Local-only — CI runs unit + typecheck only. |
| **General triage** | — | Allen | First responder for "saw a bug, fix it" — small fixes go through Allen. |

---

## 4. SOPs

### 4.1 Filing a bug

1. Reproduce. If you can't, file as `investigate:` and assign to whoever
   knows the area best — don't guess at the root cause in the description.
2. Record it locally: `HANDOFF.md` for current risks, or a focused `docs/*.md` note if it is durable.
3. Title/heading: `fix: <imperative summary, lowercase>`.
4. Description: **what / why / how-to-repro** for bugs.
5. Link code paths, logs, or reproduction commands directly in the Markdown note.

### 4.2 Picking up an issue

1. Read `HANDOFF.md` and the relevant `docs/*.md` note.
2. Check `git status --short` before editing.
3. Create a focused branch/worktree if the work is large.
4. Read referenced docs before touching code.
5. Tight feedback loop: `bun typecheck` and `bun test` after each change.
   Behavior test if the change is user-visible.
6. Update `CHANGELOG.md` for user-visible changes and commit when green.

### 4.3 Reviewing a PR

1. Pull the branch, run it locally if it's user-visible.
2. Behavior test the affected pane via the harness driver.
3. Comment-by-line in GitHub; tag with severity (nit / suggestion /
   blocker).
4. CI must be green before merge — no `--no-verify`.

### 4.4 Shipping (cycle close)

1. Review `HANDOFF.md` and recent commits to see what shipped vs. slipped.
2. Update `CHANGELOG.md` for user-visible changes.
3. Tag + publish via the existing release flow (`packages/kobe`).
4. Carry forward unfinished local follow-ups in `HANDOFF.md`.

### 4.5 Per-domain pitfalls

- **Chat / composer**: re-rendering on every signal write thrashes the
  terminal — use `untrack` and computed signals, not naive effects.
- **Hotkeys**: bare-key bindings (no modifier) collide with text input
  in composer. Default to modifiers (Ctrl/Meta); use bare keys only in
  pane-scoped contexts where input is clearly disabled.
- **Terminal**: cursor visibility is fragile — verify in both Mac and
  Linux (and ideally WSL). Don't assume escape-sequence parsing matches
  across platforms.
- **Engine**: the Claude Code subprocess can stall on permission asks
  if the stream-json parser doesn't surface the request event. See
  KOB-4 for an open investigation.
- **WSL specifics**: terminal modifier keys (Shift+Enter etc.) decode
  differently from Mac/Linux native — see KOB-3.
- **Behavior tests**: 30s+ each. Don't loop debugging by re-running;
  instrument once, surface findings if stuck (kobe team rule).

---

## 5. Communication

- **Async-first**: leave reasoning in commits, PR descriptions, and repo Markdown
  comments — not just chat. Chat is for unblocking, not record.
- **Escalate to Jackson when**:
  - Architectural decisions not in `DESIGN.md`.
  - 3-strike: same root cause failed three times.
  - Cross-domain conflicts that need scope adjudication.
  - Wave gates (G0, G1, G2, G3, G4 in `PLAN.md`) need sign-off.
- **Don't escalate**:
  - Routine compile / type errors — fix them.
  - "Did this commit go through?" — `git log`.
  - File naming / variable naming inside your domain.

---

## 6. New-domain checklist

Adding a fresh pane / module / area? Add a row to the table in §3 with:

- Folder path
- Owner (yourself if you're starting it)
- 1-line convention (what's load-bearing about this area)
- Relevant ref repo (agent-deck / opcode / claude-code)

Also drop a `<DOMAIN>.md` in `docs/` if the area has architectural
decisions worth recording.
