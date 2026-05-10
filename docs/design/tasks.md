# Tasks, Worktrees, and Chat Tabs

> Concept doc. The shapes here are the source of truth for how the
> orchestrator, the sidebar, and the chat pane talk about "what is the
> user working on right now."
>
> Companions: [`../DESIGN.md`](../DESIGN.md) §2.4 + §10 (data model) and
> §11.3 (worktree path resolution); the on-disk types in
> [`packages/kobe/src/types/task.ts`](../../packages/kobe/src/types/task.ts).

---

## 1. Three nouns

kobe has exactly three nouns in the orchestration layer. Get these
straight and the rest of the codebase reads itself.

| Noun         | What it is                                                                 | Cardinality        |
|--------------|----------------------------------------------------------------------------|--------------------|
| **Task**     | One unit of work the user is tracking. Lives in `~/.kobe/tasks.json`.      | N per repo         |
| **Worktree** | One git worktree on disk, checked out to one branch.                       | **1 per Task**     |
| **ChatTab**  | One Claude Code session, with its own conversation transcript.             | **N per Task**     |

The 1↔1↔N relationship is the whole point:

```mermaid
classDiagram
    class Task {
        ULID id
        string title
        path repo
        string branch
        path worktreePath
        TaskStatus status
        bool archived
        PermissionMode? permissionMode
        string? model
    }
    class Worktree {
        path path
        string branch
        sha head
        bool dirty
    }
    class ChatTab {
        ULID id
        string? sessionId
        string? title
        iso8601 createdAt
    }
    class Session["Claude Code session (JSONL on disk)"]

    Task "1" -- "1" Worktree : checks out
    Task "1" *-- "1..*" ChatTab : owns
    ChatTab "1" -- "0..1" Session : resumes via sessionId

    note for Task "A Task is a (worktree, branch, [chat tabs]) triple — a workspace, not a conversation."
```

A Task is a **(worktree, branch, [chat tabs])** triple. It is not "a
chat" and it is not "a branch" — it is a workspace that holds both.

---

## 2. Why one worktree per task

The whole product is built on the fact that you can have many tasks in
flight without their working trees stomping on each other. That
guarantee comes from giving each Task its own git worktree.

Concretely:

- Task `01HX...` lives at `<repo>/.claude/worktrees/01HX.../` checked
  out to whatever branch the task owns.
- Edits made in one task's worktree do not appear in another's until
  the user merges branches.
- Killing a Claude Code session does not destroy the worktree. The
  worktree persists across kobe restarts; it persists across the task
  going to `done`; it persists across archiving. The user removes
  worktrees explicitly, never as a side effect.
- The worktree root is shared with Claude Code's own agent-spawn root
  (`.claude/worktrees/`, **not** `.kobe/worktrees/`). One hidden dir,
  both tools' worktrees inside, one mental model.

The single source of truth for the path is
[`worktreePathFor(repo, taskId)`](../../packages/kobe/src/orchestrator/worktree/paths.ts).
Nothing else should concatenate `repo + '/.claude/worktrees/' + id`.

### Boundary: the orchestrator does not coordinate writes inside a worktree

When multiple ChatTabs share a worktree, it is the **user's** problem
if two tabs ask Claude to edit the same file at the same time. kobe
does not lock the filesystem, does not stage edits per-tab, does not
attempt three-way merges. The escape hatch is "open a new task" — that
gives you a fresh worktree.

---

## 3. Why N chat tabs per task

A Task is a workspace, not a conversation. People want to:

- Run a long-form refactor in tab A, then peel off tab B to ask "wait,
  why did we name this `XYZ`?" without polluting tab A's transcript.
- Have one tab per sub-thread of an exploration; close them when
  exhausted; keep the worktree.
- Resume a stale conversation while still streaming in another.

Each ChatTab has:

- An `id` (ULID).
- A `sessionId` — the Claude Code session id, `null` until the first
  prompt is sent. This is what `claude --resume <sessionId>` keys off.
- An optional `title`.
- A `createdAt` timestamp.

Tabs do **not** have their own permission mode or model — those are
task-level (see §5). All tabs in a task spawn Claude with the same
flags. If you want a different model, you want a different task.

### Tab invariants

- `tabs` is non-empty. The orchestrator refuses to close the last tab
  on a task; that's why the chat shell always has somewhere to type.
- `activeTabId` is always a valid id within `tabs`. Persisted so a
  kobe restart shows the same tab the user last used.
- Closing the active tab makes the previous-index tab active (or 0).
- `Task.sessionId` (deprecated) is a read-only alias for
  `tabs[0]?.sessionId`. Kept for v1 manifest back-compat. Writers
  must go through tab APIs.

### Lifecycle of a single tab

```mermaid
stateDiagram-v2
    [*] --> Created
    Created : sessionId = null
    Created : No engine handle
    Created --> Streaming : first prompt sent\n(engine.spawn → sessionId)
    Streaming : sessionId set
    Streaming : Engine handle live
    Streaming --> Idle : done / error / user paused
    Idle --> Streaming : engine.resume(sessionId)\n+ KOBE_RESUME_CWD
    Idle : sessionId retained
    Idle : No live handle
    Idle : History lives in JSONL

    note right of Idle
        Killing the engine does
        not delete history —
        JSONL is the source of
        truth, reread via
        engine.readHistory().
    end note
```

Killing a tab's engine does not delete its history — that lives in
Claude Code's JSONL on disk and is reread via `engine.readHistory`.

---

## 4. Task lifecycle

```mermaid
stateDiagram-v2
    [*] --> backlog
    backlog : Defined, not running
    in_progress : Engine streaming (counts toward cap)
    in_review : Engine done, awaiting user
    done : Terminal — success
    error : Terminal — engine failed (worktree preserved)
    canceled : Terminal — user canceled

    backlog --> in_progress : runTask()
    in_progress --> backlog : pauseTask()
    in_progress --> in_review : engine done + user wants review
    in_progress --> done : engine done (auto-complete)
    in_progress --> error : engine error
    in_progress --> canceled : cancelTask()
    in_review --> done : approve
    in_review --> in_progress : re-run
    done --> in_progress : re-run
    error --> in_progress : re-run

    note right of error
        Terminal but distinct
        from done — worktree
        is left intact for
        inspection.
    end note

    note left of in_progress
        Concurrency cap = 4.
        5th run → ConcurrencyCapError.
    end note
```

Status transitions are enforced explicitly in
[`orchestrator/core.ts`](../../packages/kobe/src/orchestrator/core.ts);
they are not derived from `update({ status })`. Bad transitions throw
`IllegalTransitionError` so the UI can branch.

`error` is terminal but distinct from `done`: the worktree is left
alone for inspection.

`archived` is **orthogonal to status** — a `done` task can be
archived; so can a `backlog` one. Archiving is non-destructive
(worktree stays, history stays, sidebar splits "Working session" vs.
"Archives"). The user toggles it with `a`.

### Concurrency cap

We cap `in_progress` tasks at **20**
([`CONCURRENCY_CAP`](../../packages/kobe/src/orchestrator/core.ts#L98)).
The 21st `runTask` rejects with a typed `ConcurrencyCapError`; the UI
surfaces the error and the user pauses something. Queueing is not in
scope.

---

## 5. What is task-level vs. tab-level

| Field              | Lives on   | Why                                                                  |
|--------------------|------------|----------------------------------------------------------------------|
| `repo`             | Task       | A task is anchored to one source repo.                               |
| `branch`           | Task       | One worktree → one branch → one task.                                |
| `worktreePath`     | Task       | 1:1 with the task.                                                   |
| `permissionMode`   | Task       | Spawn flag for `claude`. Cycled in the composer with shift+tab.      |
| `model`            | Task       | Same: `claude --model <id>`. Picker in the composer.                 |
| `status`           | Task       | About the work, not about any single conversation.                   |
| `archived`         | Task       | Sidebar bucket.                                                      |
| `sessionId`        | **Tab**    | Each tab is its own resumable Claude session.                        |
| `title` (chat)     | Tab        | A tab is a conversation; titles are conversation-scoped.             |
| Conversation       | Tab        | Stored in Claude Code's JSONL, keyed by `sessionId`.                 |

If a setting affects "how Claude is invoked," it's task-level. If a
setting describes "this particular conversation," it's tab-level.

---

## 6. Where things live on disk

| What                          | Where                                                  | Format                       |
|-------------------------------|--------------------------------------------------------|------------------------------|
| Task index                    | `~/.kobe/tasks.json`                                   | `TaskIndex` (versioned)      |
| Per-task worktree             | `<repo>/.claude/worktrees/<task-id>/`                  | git worktree                 |
| Per-tab conversation          | Claude Code's JSONL store (read via `AIEngine`)        | JSONL                        |
| Spawned-engine resume cwd     | typed `opts.cwd` on `engine.resume()` (+ legacy env var) | string                     |

The task index does **not** store messages. The orchestrator reads
them on demand via `engine.readHistory(sessionId)`. This is why a
crash mid-stream loses no transcript content — JSONL is the source of
truth, the index is just a manifest.

### Resume cwd — typed channel + legacy back-channel

`AIEngine.resume()` does not take a positional `cwd` parameter (only
`spawn()` does). The orchestrator runs in kobe's binary cwd, not the
task's worktree, so every resume must pass `task.worktreePath`
explicitly. The primary channel is the typed `cwd` field on
`SpawnOpts`; engines MUST honour it. The orchestrator also sets
`KOBE_RESUME_CWD = task.worktreePath` in `opts.env` as a defensive
duplicate for one release — that legacy env-var back-channel can be
removed in a follow-up once external consumers (test fixtures, MCP
bridges) are confirmed off it. Skipping cwd entirely resumes the
session in the wrong directory and is a regression-class bug —
covered by behavior tests.

---

## 7. Manifest schema versioning

`TaskIndex.version` is currently **2**. v1 had `Task.sessionId` only
(one session per task); v2 added `tabs` and `activeTabId`. The store
migrates v1 → v2 at load time by synthesizing a single tab from the
v1 `sessionId`.

`Task.sessionId` is preserved on the v2 shape as a read-only alias
into `tabs[0]?.sessionId`. Don't write through it.

When the schema changes again:

1. Bump `TaskIndex.version`.
2. Add a migration in the store's load path.
3. Leave older readable fields in place as deprecated aliases.

---

## 8. Anti-patterns

- **"Just one more sessionId on the Task."** No. Either it's a Task
  property (model / mode / status) or it's a Tab property (sessionId,
  conversation title, transcript).
- **Sharing one worktree across tasks.** Defeats the entire model.
  Every task gets its own worktree.
- **Hardcoding the worktree path.** Use `worktreePathFor`. The
  `.claude/worktrees/` convention is settled; the `.kobe/worktrees/`
  proposal is dead and any survivors are drift.
- **Storing conversation history in `tasks.json`.** It's a manifest,
  not a database. JSONL via the engine is the source of truth.
- **Auto-deleting worktrees on archive / done / cancel.** kobe never
  deletes worktrees implicitly. The user removes them explicitly or
  not at all.
