# Task-tool subagent display

> **Status: Backlog — not yet implemented.** No code changes have landed.
> This doc captures the design so the work can be picked up later. File a
> Linear issue under team `KOB` / project `Pre-1.0 整理` before starting.
>
> Companions:
> [`./tasks.md`](./tasks.md) (Task / Worktree / ChatTab model),
> [`../DESIGN.md`](../DESIGN.md) §5.2 (engine port),
> [`../../packages/kobe/src/types/engine.ts`](../../packages/kobe/src/types/engine.ts) (`EngineEvent`),
> [`../../packages/kobe/src/engine/claude-code-local/stream.ts`](../../packages/kobe/src/engine/claude-code-local/stream.ts) (the parser that currently drops these events).

---

## 1. What this is

Claude Code's built-in `Task` tool spawns a **subagent** — a child Claude
session that runs Glob / Read / Bash / etc. on the parent's behalf and
returns a final summary. In Claude Code's native TUI the subagent's
intermediate tool calls render live, indented underneath the parent's
`Task` tool row (see `refs/claude-code/src/tools/AgentTool/UI.tsx`).

kobe today **shows none of that**. The parent transcript renders one
`Task(...)` row at start, sits silent for however long the subagent
takes, then renders one final result row. Between those two points there
is no signal — no progress, no current action, no token count.

The user-facing terms "background task" and "background agent" both
refer to this same thing: a `Task`-tool subagent doing work the user
can't see.

## 2. Why we can't see it today

`packages/kobe/src/engine/claude-code-local/stream.ts` filters at the
parser:

```ts
// stream.ts:96-106
if ("parent_tool_use_id" in msg && msg.parent_tool_use_id != null) continue
```

Every stream-json event the subagent emits — its `assistant` text,
its `tool_use` blocks, its `tool_result` blocks — carries the parent's
`Task` tool-use id in `parent_tool_use_id`. The parser drops all of
them. The orchestrator never sees a subagent event; it only sees the
parent's `tool.start { name: "Task", input }` and, when the subagent
finishes, the parent's `tool.result { name: "Task", output }`.

The drop was deliberate — the original concern was that letting
subagent banners through would interleave them with the parent's
transcript and bury the `Task` row under noise. The fix isn't to
re-enable the firehose; it's to **route subagent events to a nested
display under the parent `Task` row** rather than the top-level
transcript.

## 3. Goals & non-goals

**Goals**

- Parent transcript shows the `Task` tool row plus, indented under it,
  the subagent's current and recent tool calls.
- Live streaming — tool calls appear as the subagent makes them, not
  batched on completion.
- Final "Done" summary line on the parent `Task` row when the subagent
  returns.
- Multiple concurrent `Task` tool invocations in one parent session
  render as independent groups, each with its own children.

**Non-goals**

- Surfacing subagents in the **sidebar** as if they were independent
  Tasks. Subagents have no worktree, no branch, no ChatTab — they
  don't fit the Task model in [`./tasks.md`](./tasks.md). The sidebar
  stays Tasks-only.
- Streaming the subagent's `assistant.delta` text into the parent
  transcript. Too noisy. Tool calls + final summary is enough.
- A full Ctrl+O–style global transcript mode (claude-code's). kobe has
  its own scroll model; a per-row expand toggle is enough.
- Aggregating "Running 3 agents…" across parallel subagents. Render
  each subagent group independently — Conductor-shaped UI works
  better with explicit groups than with a roll-up.

## 4. Reference: how claude-code renders it

From `refs/claude-code/src/tools/AgentTool/UI.tsx` + supporting files:

- Header is a short label (`Agent` / `Explore` / `Plan` based on
  `subagent_type`) with a spinner glyph while running.
- Subagent tool calls render inside a `Box paddingLeft={2}` — pure
  indentation, no extra prefix beyond what the tool itself renders.
- Default view shows the **last 3** progress messages
  (`MAX_PROGRESS_MESSAGES_TO_SHOW = 3`) with a `+ N more tool uses`
  summary for the rest.
- On completion, header swaps to `Done (N tool uses · X tokens · Ys)`.
- A `SubAgentProvider` context suppresses nested expand hints so the
  group reads as one block.

kobe should mirror the **shape** (indentation, last-3 + count, status
line on header) but not lift the components verbatim — kobe uses
opentui+Solid, not Ink.

## 5. Design

### 5.1 Parser — stop dropping, start tagging

`stream.ts:96-106` is replaced with passthrough. Every `assistant`,
`user`, `tool.start`, `tool.result` event the parser emits gains a
new field:

```ts
readonly parentToolUseId?: string
```

`undefined` for top-level events; the parent `Task` tool's id for
subagent events. The `toolNameById` map already in the iterator
covers tool-name enrichment for both layers — no extra state needed.

`EngineEvent` (`packages/kobe/src/types/engine.ts`) gains the optional
field on `assistant.delta`, `tool.start`, `tool.result`. `usage` stays
top-level only — Claude Code emits one terminal `result` frame and we
already treat the subagent's `usage` as part of the parent's totals.

### 5.2 Orchestrator — group by parent

The orchestrator's per-task transcript model gains a nested shape on
`Task` tool rows:

```
ToolCallRow {
  name: "Task"
  input: { prompt, description, subagent_type }
  status: "running" | "done" | "error"
  children: ChildEvent[]      // ordered, append-only
  tokenCount?: number         // accumulated from any usage events tagged with this parentToolUseId
  startedAt: epoch ms
  finishedAt?: epoch ms
}

ChildEvent =
  | { kind: "tool.start";  name; input;  toolUseId }
  | { kind: "tool.result"; name; output; toolUseId }
```

Routing rule: any event with `parentToolUseId === T.toolUseId` appends
to `T.children`. The top-level transcript stays flat — only `Task`
tool rows carry children.

A subagent's `assistant.delta` events are still received by the
orchestrator (so we don't silently drop data) but the chat renderer
ignores them by default (see Non-goals §3).

### 5.3 Renderer — chat pane

In the chat pane's tool-row component:

**Running**

```
⏺ Task(<description, or input.prompt truncated to ~60 chars>)
   ⎿  Bash(npm test)
      Read(src/foo.ts)
      Glob(**/*.test.ts)
      + 4 more tool uses
```

- Indent the children block with the same gutter the chat already
  uses for tool-result bodies (no new geometry).
- Show the last 3 children. Earlier ones collapse to
  `+ N more tool uses`.
- Header carries a spinner while `status === "running"`.

**Done**

```
⏺ Task(<description>)  Done (7 tool uses · 12.4k tokens · 18s)
```

- Children block stays visible by default (last 3 + count). The
  group reads as a closed unit.
- Token count is best-effort: omit the segment if no `usage` was
  ever tagged with this parent.

**Error**

```
⏺ Task(<description>)  Error: <message>
```

### 5.4 Per-row expand / collapse

Each `Task` tool row gets a row-scoped hotkey (proposed: `o` on the
focused row; final binding goes through
[`KEYBINDINGS.md`](../KEYBINDINGS.md) review). Expanded state shows
every child in order with no truncation. State lives on the row, not
globally — different rows can be expanded simultaneously.

No global "expand all subagents" mode. The user already has chat
scroll; nested unbounded transcripts inside a single row would fight
that.

### 5.5 Multiple concurrent subagents

When the parent fires two `Task` tools in the same turn, the parser
emits two `tool.start` rows with distinct ids. Each becomes its own
group. The orchestrator routes by `parentToolUseId` — there is no
shared bucket. The chat renders them in stream order, each with its
own children block.

No aggregated header. Two groups, two indented blocks, two `Done`
lines.

## 6. Phasing

Three Linear issues, one per step. Each is a single-stream slice and
ships independently.

1. **Parser + types.** Remove the drop, add `parentToolUseId` to the
   relevant `EngineEvent` cases, thread through `ClaudeCodeLocal`.
   No UI change — verify via unit test on the parser plus a behavior
   test that asserts the orchestrator receives the previously-dropped
   events.
2. **Orchestrator grouping.** Wire children onto `Task` tool rows,
   accumulate token counts, derive `status`/`finishedAt`. No chat
   render change; behavior test asserts the in-memory transcript
   shape.
3. **Chat render + per-row expand.** Implement the running / done /
   error layouts from §5.3 and the row-level `o` toggle from §5.4.
   Behavior test drives a real `Task` invocation under PTY and
   asserts the indented children block appears.

Each step is a separate commit, each closes its own Linear issue. No
single PR carries all three — keep the diffs reviewable.

## 7. Open questions

- **Tool-result display inside the children block.** kobe's normal
  tool-result rows can be large (Read outputs, Bash transcripts). At
  indent depth they could blow up the row. Default proposal: render
  subagent `tool.result` as a one-line summary (`Read(src/foo.ts) →
  3.2 KB`) and only show the body when the row is expanded. To be
  confirmed when step 3 lands.
- **Token-count source.** If Claude Code only emits the `usage` /
  `result` frame at the top level (not per subagent), we cannot
  attribute tokens to a single subagent. Verify against the
  stream-json schema in step 1; if so, drop the `· tokens` segment
  from the Done line rather than faking it.
- **Hotkey letter.** `o` is convenient but currently unbound in the
  chat pane — confirm against [`KEYBINDINGS.md`](../KEYBINDINGS.md)
  during step 3. If `o` is taken by then, `e` is the obvious
  alternate.
