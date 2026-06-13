# Cross-task memory — investigation note (2026-06-11)

Status: **assessment, no decision**. Question asked: should kobe add an external
memory layer (mem0 / Letta style) so tasks can share learned context?

## TL;DR

Don't embed mem0 or Letta. By mid-2026 the engines themselves shipped
transcript→memory extraction, and under kobe's `Task = worktree + engine session`
model the Claude Code variant is **already cross-task**:

- **Claude Code auto memory** (v2.1.59+, on by default) writes
  `~/.claude/projects/<project>/memory/` — scoped **per git repository and shared
  across all worktrees of that repo**. Every kobe task on the same repo reads and
  writes the same memory dir, with zero kobe code. A background consolidation pass
  ("auto dream") dedupes/rewrites it from recent transcripts.
- **Codex Memories** (v0.128+, off by default, `[features] memories = true`)
  background-summarizes finished threads into `~/.codex/memories/`, loaded at
  session start. Engine-managed, local-only.
- kobe never overrides the engine's `HOME` (`KOBE_HOME_DIR` only moves kobe's own
  state — `env.ts`; `session-layout.ts` weaves no env into the launch line), so
  both features work in kobe tasks untouched today.

## Why the named candidates don't fit

| Candidate | Shape | Verdict |
|---|---|---|
| **Letta** (MemGPT) | Full stateful-agent **runtime** — agents run inside its server; memory is not separable from its loop | Architecturally disqualified: kobe deliberately does not own the agent loop |
| **mem0 SDK in the daemon** | Library embed: daemon harvests transcripts via `EngineHistoryReader`, calls `memory.add/search` | Requires kobe to make LLM + embedding calls (API keys, cost, provider config) — kobe makes **zero** LLM calls today and that's a feature. Duplicates what engines now do natively |
| **OpenMemory MCP** (mem0's local server) | Docker stack (FastAPI + Qdrant + Postgres) exposing `add/search_memory` MCP tools; the **engine** calls it, not kobe | The only shape compatible with kobe's "not in the prompt path" position — but heavy footprint, and only worth it for the one real gap below |

kobe sits outside the prompt path (engines are tmux subprocesses), so its only
integration surfaces are: files the engine reads (CLAUDE.md / AGENTS.md /
init-prompt), engine hooks (SessionStart/SessionEnd), and MCP servers registered
in the engine's own config. Anything that requires intercepting the conversation
is off the table by design.

No competing orchestrator (Conductor, claude-squad, vibe-kanban, opcode, Crystal)
ships a cross-task memory layer as of mid-2026 — the ecosystem pattern is
worktree isolation + human merge review. No precedent pressure.

## The one real gap: cross-ENGINE memory

Engine-native memory is siloed per vendor: a Claude task's learnings never reach
a Codex task on the same repo. If that ever matters, the idiomatic fix is a
**shared MCP memory server registered into each engine's worktree config**
(OpenMemory, or a lighter file-backed server) — kobe's role would be wiring the
registration (init script / repo config), not owning storage or extraction.
Defer until a concrete need surfaces; mixed-vendor-same-repo usage is rare today.

## Cheap kobe-level follow-ups (if/when memory work is picked up)

1. **Surface, don't build**: show the repo's engine memory state in kobe (e.g. a
   Settings/Ops indicator that auto memory exists for this repo, or a `kobe repo`
   subcommand opening the memory dir). Per the engine-owned-UI-data rule this
   goes through the engine contract — e.g. an optional `EngineMemoryInfo`
   capability (dir path, enabled?, last consolidated) on the registry entry, not
   vendor `if`s in the TUI.
2. **Codex parity nudge**: Codex Memories is off by default; a per-repo init
   could opt in (`~/.codex/config.toml` is global though — needs care, and it's
   the user's file, not kobe's).
3. **First-prompt enrichment stays static**: `resolveRepoInit` keeps delivering
   the committed `.kobe/init-prompt.md`; dynamic "lessons learned" injection is
   the engine's job (SessionStart hook / MEMORY.md auto-load), not kobe's.

## Sources

- Claude Code memory docs: https://code.claude.com/docs/en/memory
- Codex memories: https://developers.openai.com/codex/memories
- mem0 OSS / OpenMemory MCP: https://docs.mem0.ai/open-source/overview,
  https://mem0.ai/blog/introducing-openmemory-mcp
- Letta core concepts: https://docs.letta.com/core-concepts/
- Orchestrator survey (no memory precedent): https://rustman.org/wiki/conductor-parallel-agents/
