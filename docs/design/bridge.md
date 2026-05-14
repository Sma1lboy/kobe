# Bridge — exposing kobe to its own spawned agents

> Concept + follow-up doc. The first iteration shipped in `bad2ccb`
> (KOB-30). This file captures the architecture, what is deliberately
> unfinished, and the open distribution decision for the agent-side
> skill that teaches the model when to use these tools.
>
> **As of KOB-134/KOB-138, `kobe api <verb>` is the recommended path
> for agent-driven access; see [`cli-api.md`](./cli-api.md). The MCP
> bridge documented below remains in tree as a fallback for installs
> that already use it, but new work targets the CLI surface.**

---

## 1. What shipped

A Claude Code subprocess kobe spawns can call back into the running
kobe process via four MCP tools: `kobe_spawn_task`,
`kobe_list_tasks`, `kobe_get_task`, `kobe_send_message`.

The wiring:

```
┌─────────────── kobe (TUI process) ────────────────┐
│  Orchestrator ── TaskIndexStore ── Solid signals  │
│         ▲                              │          │
│  RPC handler                           │          │
│  (newline JSON)                        ▼          │
│  Unix socket  ◀── kobe mcp-bridge      UI panes   │
└────────────────────┬──────────────────────────────┘
                     │  (subprocess of claude)
                     │  stdio MCP/JSON-RPC
                     ▼
        ┌────── claude -p (in worktree) ──────┐
        │  --mcp-config ~/.kobe/run/mcp.json  │
        │   ↓ tools/list                      │
        │   ↓ tools/call kobe_spawn_task      │
        └─────────────────────────────────────┘
```

UI updates are free: the RPC handler drives the same `Orchestrator`
the TUI subscribes to, so a `spawn_task` from the agent reactively
adds a card to the sidebar.

Code surface:
- [`packages/kobe/src/orchestrator/bridge/server.ts`](../../packages/kobe/src/orchestrator/bridge/server.ts) — RPC server.
- [`packages/kobe/src/orchestrator/bridge/index.ts`](../../packages/kobe/src/orchestrator/bridge/index.ts) — bootstrap (writes mcp.json, exports `KOBE_MCP_CONFIG`).
- [`packages/kobe/src/cli/mcp-bridge.ts`](../../packages/kobe/src/cli/mcp-bridge.ts) — `kobe mcp-bridge` stdio shim.
- [`packages/kobe/src/engine/claude-code-local/spawn.ts`](../../packages/kobe/src/engine/claude-code-local/spawn.ts) — auto-appends `--mcp-config` when env var is set.
- [`packages/kobe/test/orchestrator/bridge.test.ts`](../../packages/kobe/test/orchestrator/bridge.test.ts) — smoke tests.

---

## 2. What is deliberately unfinished (KOB-30 closing notes)

- **No recursion guard.** Sub-tasks inherit `KOBE_MCP_CONFIG` and can
  also call `kobe_spawn_task`. Add a parent-task-id check on the
  socket side once a real fan-out / fork-bomb pattern surfaces.
- **No resource gate.** Existing `CONCURRENCY_CAP = 4` in the
  orchestrator catches us, but there's no per-RPC confirm or
  `maxConcurrentSpawns` knob.
- **No agent-spawned marker.** The sidebar card looks identical
  whether the user clicked "new task" or the agent fanned out. A
  small 🤖 chip would help Jackson visually triage.
- **No auth on the socket.** The path is pid-scoped under
  `~/.kobe/run/`; relies on filesystem perms. Fine for local; revisit
  if anything ever opens it over a network.
- **Skill distribution unsolved.** Tools are visible to the agent;
  the agent doesn't proactively use them without a SKILL.md telling
  it when to. See §4.

---

## 3. RPC surface (current)

| MCP tool name | RPC method | Inputs | Returns |
|---|---|---|---|
| `kobe_spawn_task` | `spawn_task` | `repo`, `prompt`, `title?`, `base_branch?` | task snapshot — returns BEFORE worktree allocation; caller polls `kobe_get_task` for `worktree_path` / `branch` |
| `kobe_list_tasks` | `list_tasks` | — | `Task[]` snapshot |
| `kobe_get_task` | `get_task` | `task_id` | `Task` |
| `kobe_send_message` | `send_message` | `task_id`, `prompt` | `{ ok: true }` (awaits `runTask`) |

Anticipated additions when needed:
- `kobe_wait_idle(task_id, timeout?)` — block until the spawned task
  hits `idle` / `awaiting-approval`. The synchronization primitive a
  fan-out + join workflow needs.
- `kobe_archive_task(task_id)` — let an agent clean up after a fan-out
  it's done with. (Hard rule: NEVER delete; archiving is the maximum
  destruction we hand to a tool.)

---

## 4. Open: how do we ship the skill?

The bridge gives agents the *capability*. The skill (a markdown file
the model reads at session start) gives them the *intent* — "you are
running inside kobe; when the user asks for parallel exploration,
prefer `kobe_spawn_task` over doing N things sequentially in one
chat."

Three options on the table; pick before doing the work. ABC are
listed in increasing user-friendliness, decreasing engineering cost.

### Option A — auto-write to `~/.claude/skills/kobe/` on first launch

kobe checks at boot for `~/.claude/skills/kobe/SKILL.md`; if absent,
writes the bundled template. Idempotent thereafter; never overwrites
a user-modified copy.

- ➕ Zero steps. User installs kobe, gets the behavior.
- ➖ Pollutes the user's global Claude Code skills directory without
  explicit consent.
- ➖ Updating the bundled skill across kobe versions creates an
  awkward "your local copy diverges from the new bundled one" prompt.

### Option B — `kobe install-skill` subcommand

User runs `kobe install-skill` once. Subcommand writes to
`~/.claude/skills/kobe/SKILL.md`; if the file exists, prints a diff
and asks `overwrite / skip / cancel`.

- ➕ Knowing consent. User can re-run after upgrades to pull updates.
- ➕ Trivial to back out (`rm -rf ~/.claude/skills/kobe/`).
- ➖ User needs to know the command exists. Requires a README pointer
  + a `kobe diagnose` line ("kobe-fanout skill: not installed —
  run `kobe install-skill`").

### Option C — first-launch onboarding banner

First time kobe boots without the skill installed, the chat pane
shows a one-shot banner: `Enable parallel-task skill? [Enter to
install / Esc to skip / S to silence]`. Persist the choice in a
small KV entry so we never ask again.

- ➕ Knowing consent + zero learning cost.
- ➕ Smooth path for new users; "S to silence" respects power users.
- ➖ Need a chat-banner component (doesn't exist yet) + KV-persisted
  preference.
- ➖ The decision is visible right when the user is trying to focus on
  their first task — risk of being annoying. Has to be a single
  unobtrusive row, not a modal.

### Recommended path

**Ship B first, upgrade to C when user volume justifies it.** Project-
level overrides via `<repo>/.claude/skills/kobe/SKILL.md` (Claude
Code's discovery order: project > user > none) are free and don't
need any kobe code.

**Skip D (per-worktree skill injection)**: tempting because it's
self-contained, but every spawned worktree gets a redundant copy and
users can't disable / customize at one central point.

### Skill content sketch

A single SKILL.md, ~40-80 lines. Sections:

- **Trigger.** Exact phrases that should fire fan-out:
  `并行试 N 个`, `fan out`, `try a few approaches in parallel`,
  `split this into subtasks`, `compare implementations side-by-side`.
- **How.** `kobe_spawn_task` ≤ 3-4 in parallel; each gets its own
  scoped prompt (don't dump the whole convo); poll
  `kobe_get_task` for status; aggregate results in the parent chat
  before reporting back to the user.
- **Don't.** Single simple tasks → no spawn. Don't recursively spawn
  from inside a spawned task (no recursion guard yet, will deadlock
  the concurrency cap fast). Don't use `kobe_send_message` as a chat
  channel — every message is a full agent turn, expensive.
- **Visibility note.** Tell the user what was spawned ("starting 3
  parallel attempts: A, B, C — IDs <id1> <id2> <id3>") so the sidebar
  reads back correctly.

Tracked as **KOB-31** for execution.

---

## 5. Reference: how the parts compose at runtime

1. `startApp` builds the orchestrator, then calls `startBridge(orch)`.
2. `startBridge` binds `~/.kobe/run/bridge-<pid>.sock`, writes
   `~/.kobe/run/mcp-<pid>.json` with `{ command: bun, args: [<entry>,
   "mcp-bridge", "--socket=..."] }`, sets `process.env.KOBE_MCP_CONFIG`.
3. Every subsequent `engine.spawn(...)` enters
   `claude-code-local/spawn.ts buildArgs`, which sees the env var and
   appends `--mcp-config <path>` to the claude argv.
4. claude reads the config, spawns `kobe mcp-bridge --socket=...` as
   a child, and exposes its `tools/list` (the four `kobe_*` tools) to
   the model.
5. Model calls a tool → claude forwards `tools/call` over stdio to the
   bridge subprocess → bridge translates to `{method, params}` over
   the Unix socket → kobe RPC handler invokes the orchestrator → store
   mutates → Solid signal fires → sidebar redraws.

The whole loop is one event loop tick from MCP frame to UI repaint.
