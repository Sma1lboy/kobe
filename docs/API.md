# rove api

`rove api` is Rove's scriptable surface: the verbs a shell script — or
another AI agent — uses to spawn tasks, supervise them, read their output,
and land the winner, with no TUI attached.

Each invocation is a short-lived process: connect to (or auto-start) the
daemon, do the work, print one JSON object to stdout, exit. Read-only verbs
marked *offline* below skip the daemon entirely.

`rove api schema` is **the** source of truth when this page and the binary
disagree: names, types, required flags, and enum values, as JSON. Agents
should read it once and drill in with `--verb <name>` instead of parsing
this page. The rest of the binary is documented in the
[CLI reference](./CLI.md).

To teach a coding agent this surface, install the bundled agent skill —
`rove skill install` — instead of pasting this page into a prompt.

## The orchestration loop

Running many agents well is graph engineering, not prompt engineering:
isolated attempts as nodes, your judgment at the gates. Four moves, one
verb each.

**Fan out** — one prompt, N isolated attempts, one call. `add` is the
create verb whether you want one task or five; `--count N` (or `--agents`
for a mixed fleet) is what makes it a parallel round:

```bash
rove api add --repo "$PWD" \
  --agents claude:2,codex:2,copilot:1 \
  --prompt "Try independent approaches to simplify the auth flow."
```

**Completion** — a worker spawned from another Rove task sends its outcome
back to the dispatching engine tab: creation records the dispatcher
(task + tab), so a bare `send` routes home without any id in hand; no
stored report, no blocking wait. Silence is a checkpoint, never a verdict:

```bash
rove api send --prompt "succeeded: auth flow simplified (branch fix/auth-flow)"
```

**Observe** — read the engine's own structured session, never scrape a TUI
screen:

```bash
rove api read-output --task-id <id>    # paged history, honest terminal fallback
rove api read-output --task-id <id> --tab tab-3   # one exact tab's terminal
```

**Fan in** — compare the attempts, then land one:

```bash
rove api collect --task-ids a,b,c      # read-only comparison snapshot
rove api land --task-id a              # merge the winning branch
```

## Output + exit-code contract

- **Success** → one JSON object on stdout, newline-terminated, exit 0.
  `--pretty` indents it (humans only).
- **Error** → `{ "error": { "message", "code", ... } }` on stderr. Common
  rejections additionally carry `hint` and `nextCommandArgs` (argv runnable
  verbatim) so a caller can self-heal without parsing prose.
- Exit codes: `0` success · `1` handler/RPC failure · `2` usage errors
  (unknown verb, bad/missing flag, unreachable daemon) · `3` partial
  parallel round (some tasks created, some failed; the full payload still
  goes to stdout so created tasks are never lost).
- `rove api <verb> --help` prints that verb's usage and exits 0.

Flag parsing: `--key value` and `--key=value` both work; boolean flags may
be given bare (`--force` ⇒ true) or explicitly (`--archived=false`);
`--task-id` / enum / positive-int values are validated against the verb's
spec, and unknown flags are rejected (exit 2). `--repo` resolves relative
paths against `$PWD` (`~` expanded). `spawn-task` is an alias of `add`.

Engines are chosen by COMMAND, not by a vendor enum: `--command` takes an
engine id from `engine-list` (`claude`, `codex`, `copilot`, `kimi`, plus any
engine you registered) **or** a full command line Rove runs verbatim
(`--command "codex --search"`). Nothing validates an engine's flags — probe
an unfamiliar one with `<cmd> --help` before dispatching. See
[ENGINES.md](./ENGINES.md#engine-presets-and-protocols) for how the protocol
Rove speaks to a command is derived from it.

Two verbs were REMOVED (no aliases): `fan-out` → `add --count N`, and
`set-vendor` → `set-command`. Calling either returns `UNKNOWN_VERB` with the
replacement in `nextCommandArgs`.

## Discovery

- `schema` *(offline)*: the API, as JSON. Default is a compact index
  (groups + verb summaries, no flags); drill in with `--verb <name>` (full
  flag detail for one verb), `--group <g>`, or `--all` (everything; large).
  Includes an `apiVersion` agents can gate on.
- `engine-list` *(offline)*: every engine Rove can launch — built-ins and
  your registered presets — each with the RAW command it runs, its display
  name, and its `protocol` (the adapter Rove speaks to it: history reads,
  trust pre-answer, first-message delivery; `generic` = none). What it
  prints is what a launch runs, so an entry can be copied into `--command`
  verbatim or edited first. Returns `{ engines }`.

## read

- `list`: list all tasks (incl. archived). Returns `{ tasks }`.
- `get-task --task-id <id>`: one task's metadata; `.running` = any of its
  hosted engine tabs is live (not just the first); `.tabs` = the task's
  terminal tabs (`id`/`kind`/`title`/`vendor`/`liveVendor`/`lastTitle`/
  `autoTitle` + per-tab `alive`) — the discovery read for `send --tab tab-N`.
  `liveVendor` on a live tab is a fresh foreground process walk (which
  engine actually runs in the tab's shell right now — a hand-typed `claude`
  in a shell tab counts, a ctrl+C'd engine doesn't); dead tabs report the
  last recorded value.
  A dead tab whose session ended abnormally also carries `exit`
  (`code`/`signal`/`at`); clean exits stay `exit: null`. A live PTY session
  the persisted snapshot does not list still gets a row, marked
  `unregistered: true` — an alive engine is never invisible here.
  `.task.dispatcher` (`{taskId, tabId}`) = the Rove session that created the
  task, when one did — the lineage read for a parallel round's parent.
  `.task.command` = the raw launch command pinned on the task; `.task.vendor`
  = the protocol derived from it.
- `collect [--task-ids a,b,c] [--repo PATH]`: read-only comparison
  snapshot of several tasks: identity, branch, lineage (`.dispatcher`,
  `.groupId`), `.running`, per-tab `.tabs` (the same join as `get-task` —
  pick a `send --tab` target without a second hop), uncommitted `.changes`,
  and committed `.base` (ahead count + diffstat vs base).
- `digest --repo PATH [--since-days N]`: the repo's recent agent work —
  tasks touched in the window plus routine outcomes by status. Default
  window 7 days. Task outcomes are deliberately absent: completion travels
  to the spawning agent's engine tab (`send`), not into Rove state.
- `agent-turns [--task-id ID] [--repo PATH] [--since-days N] [--limit N]`:
  per-turn agent telemetry — one record per completed engine turn
  (`taskId`/`tabId`/`vendor`/`model`/`sessionId`/`startedAt`/`endedAt`/
  `usage`), newest first, plus a `totals` roll-up (token sums, summed
  wall-clock, turn counts per model). Default window 7 days, 200 records.
  Records are produced by each engine's own adapter from that vendor's
  transcript and stored by the daemon on `turn-complete`; engines without a
  turn reader contribute nothing. Read-only.
- `pty-list` *(offline)*: hosted PTY sessions (key, alive, pid, command,
  live window title). Empty when no PTY host runs.
- `read-output [--task-id ID] [--tab TAB] [--source auto|history|terminal]
  [--cursor C] [--limit N]`: a task's engine output as bounded, cursor-paged
  JSON — structured history when the engine has it, else a labeled terminal
  tail (`fallbackReason`). The cursor is pinned to one source/session/tab and
  returns `SOURCE_CHANGED` if that moved. `--tab tab-N` reads exactly that
  tab's hosted terminal session (terminal-only; `TAB_NOT_FOUND` when the tab
  has no session). A dead session's terminal page includes `terminal.exit`
  (`code`/`signal`/`at`) while the PTY host still runs.
- `inspect [--task-id ID]` *(offline)*: diagnostics in one read, across four
  sections — `daemon` (raw per-task/per-tab activity entries), `sessions`
  (PTY inventory joined with a live process-tree walk; dead sessions carry
  `exit`), `sessionExits` (durable death records — exit `code`/`signal`/`at`
  plus a plain-text output `tail`, kept in `pty-exits.json` so they survive
  the PTY host's idle-exit; abnormal exits only), and `tabs` (the
  snapshots the sidebar names its rows from, reconciled against the live
  session inventory: a task whose snapshot is missing an alive
  `<taskId>::tab-N` session reports those tab ids under `unregistered`,
  and a task with live sessions but no snapshot at all still gets an
  entry). Non-spawning: a missing daemon
  or PTY host degrades that section to `null`. **Run and paste this first**
  when reporting a badge, label, engine-identity, or engine-crash bug.

## create

- `add --repo PATH [--title T] [--branch B] [--base-branch B]
  [--command CMD] [--count N | --agents claude:2,codex:1] [--status S]
  [--pin] [--activate] [--prompt TEXT]`: create a task (appears in the
  sidebar immediately). With `--prompt` it also materializes the worktree,
  starts the engine, and delivers the prompt. Does not steal focus unless
  `--activate`. Alias: `spawn-task`. Without `--branch`, the branch name is
  auto-derived from the title following the repo's own branch-naming
  convention (inferred from its existing local + origin branches — e.g.
  `feat/login-flow` in a type-prefixed repo, `login-flow` in a bare-slug or
  empty repo; name collisions get a short `-2`/`-3` suffix).

  **Parallel attempts** live here too: `--count N` spawns N sibling tasks of
  the SAME prompt, each with its own worktree and branch, sharing one
  `groupId` and `#i/N` titles; `--agents claude:2,codex:1` does the same
  with a mixed fleet (engine IDS only — a raw command line can't be
  expressed per-sibling; issue N separate `add --command` calls for that).
  Capped at 10; prefer 3-4. Both require `--prompt` (a parallel round IS its
  prompt) and reject `--branch` (siblings cannot share one branch). This was
  the `fan-out` verb, which no longer exists.

  `--command` picks the engine (an id from `engine-list`, or a full command
  line). Omitted, the repo's default engine is used.

A create issued from inside a Rove engine tab records
the caller as the new task's `dispatcher` (`{taskId, tabId}` from
`$ROVE_TASK_ID`/`$ROVE_TAB_ID`, with Kobe aliases) — the reply address the worker's bare
`send` routes back to. Creates from a plain shell or the TUI record none.

Those env vars are **verified, not trusted**: an environment variable is
inherited by every descendant process, so an agent's detached background
process keeps exporting the ids of a tab it no longer runs in, and every
task it creates would name a stranger's session as its dispatcher. Rove
believes the pair only when `<taskId>::<tabId>` is a live session AND that
session's shell is an ancestor of the calling process. When it isn't, the
dispatcher / `[KOBE PEER]` provenance / spawner coda are all omitted (a
wrong reply address delivers to someone else; no address at least fails
visibly), and the verb's JSON result carries an `identityWarning` field
saying so.

A new task's FIRST prompt (`add --prompt`, a parallel round, quick-fork) gets a
short coda appended asking the agent to `set-branch` the auto-generated
placeholder branch to a descriptive name. Prompts into existing sessions
(`send`, `send --tab new`, `dispatch`) are never modified.

## drive

- `send [--task-id ID] --prompt TEXT [--tab TAB] [--command CMD] [--plain]`: paste a
  follow-up into a task's running engine (one full turn). Without
  `--task-id`, a task that has a `dispatcher` on record replies to that
  exact tab — falling back to the dispatcher task's live canonical engine
  tab when the tab died, and failing loud (`DISPATCHER_UNREACHABLE`) when
  nothing on that task is alive, never silently spawning a new engine.
  Otherwise the default is the active task and its canonical engine tab.
  From another Rove task, the message includes `[KOBE PEER]` provenance and
  a tab-precise reply command (`--task-id <sender> --tab <sender's tab>`);
  `--plain` skips that prefix. `--tab new` spawns a fresh engine tab, while
  `--tab tab-N` targets that exact tab (`TAB_NOT_FOUND` if it is dead or
  absent). `--command CMD` is valid only with `--tab new`: it pins that new
  tab to that engine without changing the task's own. Using it with an
  existing tab is a `BAD_FLAG` error rather than a silent switch.
  Delivery needs a live engine in that tab: one that exited into the
  keep-alive shell refuses with `ENGINE_NOT_RUNNING` and a `--tab new` hint
  instead of pasting into a shell. Any registered engine passes, so a tab may
  run a different vendor than its task. Without `--tab`, the canonical target
  is a live engine tab (`tab-1` first, then any surviving engine tab); when
  live tabs exist but none resolves as an engine, `send` refuses with
  `NO_ENGINE_TAB` rather than silently spawning a duplicate engine. Only a
  task with no live session at all auto-starts its canonical engine tab, in
  the task's worktree — `started: true` in the result marks that fresh
  session (vs. delivery into an existing one).
- `dispatch --task-id ID --prompt TEXT [--tab TAB]`: route text into a
  task's live session via the daemon's `session.deliver` channel; requires an
  already-hosted session (the dispatcher's messenger; see
  [design/dispatcher.md](./design/dispatcher.md)). `--tab tab-N` delivers
  into exactly that tab instead of the canonical engine tab.
- `note --task-id ID --text TEXT`: file a one-line field note (a resolved,
  repo-level gotcha). Appended to the repo's durable note store — every
  future worktree session on this repo starts with it in its system prompt —
  and forwarded to the dispatcher session for live relay to in-flight tasks.
- `note-list --repo PATH`: read a repo's accumulated field notes, newest
  first. Returns `{ notes }`.
- `set-active [--task-id ID] [--none]`: set (or clear) the shared active
  task every attached sidebar highlights.
- `pane-open [--task-id ID] [--tab TAB] [--command CMD] [--direction
  right|down] [--placement split|tab] [--title TEXT]`: open a terminal pane
  in a task's workspace — split the focused tab (default, tmux-style
  beside/below the active pane; `--tab tab-N` hosts the split in that tab
  instead) or open a separate command tab. `--command` runs via
  `sh -lc` and the pane closes when it exits; omit it for an interactive
  shell. Broadcast over the daemon's `tab.open` channel, so an attached TUI
  showing the task performs the split (headless, nothing happens). Task
  defaults to `$ROVE_TASK_ID` (or its Kobe alias), then the active task. How far splits can go
  is decided by the terminal's size: a split that would shrink any pane
  below the minimum usable size (20×6 cells) falls back to a tab.
- `pane-close [--task-id ID] --title TEXT [--tab TAB]`: the inverse — close
  every pane (split leaf / command tab) in the task whose label matches
  `--title`, the title it was opened with; `--tab tab-N` scopes the match to
  one tab. Engine panes are never closed. Broadcast over the daemon's
  `tab.close` channel; an attached TUI performs the close (headless, nothing
  happens).

## edit

- `rename --task-id ID --title T`: set a task's title.
- `set-branch --task-id ID --branch B`: rename a task's branch
  (`git branch -m` if materialized, else recorded).
- `set-command --task-id ID --command CMD`: set a task's engine launch
  command (takes effect on next session rebuild). The protocol Rove speaks
  to it is derived from the command; the result reports which one, and
  `generic` when the command names no engine Rove knows. Replaces the
  removed `set-vendor`.
- `set-status --task-id ID --status S`: set lifecycle status:
  `backlog`, `in_progress`, `in_review`, `done`, `canceled`, `error`.

## issues

The daemon-owned issue store (backlog; see
[WORK-TRACKING.md](./WORK-TRACKING.md)). Statuses: `open`, `doing`, `hold`,
`done`.

- `issue-list --repo PATH`: list a repo's issues.
- `issue-create --repo PATH --title T [--body TEXT]`: create an issue.
- `issue-set-status --repo PATH --id N --status S`: set an issue's status.
- `issue-update --repo PATH --id N [--title T] [--body TEXT] [--task ID]`:
  edit title/body and/or link a task (kanban: In progress; `--task none`
  unlinks).

## workitems

A **read-only** view of a repo's GitHub issues (through the `gh` CLI), plus one
action: start a task on one. Deliberately not an import — the issue stays
GitHub's, and nothing is copied into Rove's own issue store. Mechanics:
[design/work-items.md](./design/work-items.md).

- `workitem-list --repo PATH [--state open|closed|all] [--limit N] [--search Q]
  [--assignee USER] [--label L]`: list issues. `--assignee @me` for your own.
- `workitem-start --repo PATH --number N [--vendor V] [--base-branch B]`:
  create a task for issue N and start its engine with the issue title, body,
  and URL as the first message. The task keeps a `linkedWorkItem` pointing
  back, and its branch derives from the issue title following the repo's
  branch-naming convention.

Requires `gh` installed and authenticated; failures name which of those is
missing (`gh-missing` / `auth` / `no-remote`) rather than a generic error.

## routine

Scheduled agent tasks (Routines): a cron rule + a prompt + a repo. Every firing creates a
**fresh task** (worktree + branch + engine session) with the prompt as its
first message — a run is an ordinary task you can open and keep talking to.
An enabled routine keeps the daemon alive so schedules fire with no TUI
attached. Walkthrough: [Routines](ROUTINES.md). Mechanics:
[design/automations.md](./design/automations.md).

- `routine-list`: every routine with its next run time.
- `routine-create --repo PATH --name N --prompt TEXT --schedule CRON
  [--vendor V] [--base-branch B] [--precheck CMD] [--precheck-timeout SEC]
  [--grace MIN] [--disabled]`: schedule a prompt. `--schedule` is five-field
  cron in the daemon host's local time (`"0 9 * * MON-FRI"`).
- `routine-update --id ID [...]`: change any field. A new `--schedule`
  re-anchors the next run; `--precheck ''` clears the precheck.
- `routine-set-enabled --id ID --enabled BOOL`: pause / resume.
- `routine-run-now --id ID`: run immediately, skipping the precheck. Does
  not shift the schedule.
- `routine-runs --id ID`: run history, newest first.
- `routine-delete --id ID`: delete it and its history (tasks it already
  created are untouched).

**`--precheck`** runs a shell command in the repo before the engine starts;
a non-zero exit skips the run *without* creating a task. Use it so a schedule
does not burn a turn when nothing changed (`git log --since=24.hours --oneline
| grep -q .`). Run statuses distinguish `skipped_precheck` (healthy — nothing
to do) from `dispatch_failed` (needs a human).

## lifecycle

- `archive --task-id ID [--archived=false]`: archive/unarchive.
  Non-destructive: worktree, branch, and history stay. A manual "hide the
  row" override — once work is merged, `delete` (branch survives) is the
  normal cleanup path; see
  [`design/task-lifecycle.md`](./design/task-lifecycle.md).
- `pin --task-id ID [--pinned=false]`: pin/unpin a task to the top of the
  sidebar.
- `land --task-id ID [--strategy merge|squash] [--delete-branch]
  [--then-archive] [--remove-worktree]`: merge a task's branch back into its
  base repo's current branch (`--no-ff` merge, or one squash commit). Refuses
  a dirty base checkout; on conflict it aborts and returns the conflicted
  files. Returns `{ landedOn, commit }`.
  `--remove-worktree` removes the task's worktree after a successful land —
  the branch stays (pair with `--delete-branch` to drop it too). It never
  forces: a dirty worktree, the base checkout, and the worktree the caller is
  running from are all refused, and the outcome lands in the result's
  `worktree` field (`{ removed, reason? }`) instead of failing the land.
- `delete --task-id ID [--force] [--delete-branch]`: remove a task and its
  worktree. **The git branch stays** unless `--delete-branch` is passed —
  git is the durable record, the task row is not. Needs `--force` on a
  dirty worktree; `--force` never implies `--delete-branch`.

## worktree

- `ensure-worktree --task-id ID`: materialize a task's git worktree on
  disk now (without starting an engine). Returns `{ worktreePath }`.
- `discover-adoptable --repo PATH`: list existing git worktrees not yet
  tracked as Rove tasks.
- `adopt --repo PATH --worktree PATH [--branch B] [--command CMD] [--title T]`:
  import an existing git worktree as a Rove task.

## feedback + other

- `feedback --title T --body TEXT [--category SLUG]` *(offline)*: create a
  GitHub Discussion in the Rove repository's Feedback category via `gh`.
- `notify --title TEXT [--kind KIND] [--task-id ID] [--source TAG]`: show
  a toast in every attached Rove UI. `done` / `needs_input` / `error` get
  severity styling; any other kind renders neutrally.
- `prompt --title TEXT [--placeholder T] [--initial T] [--timeout MS]`:
  ask the human for a line of text through the attached TUI's input dialog;
  blocks until answered/cancelled/timeout (default 120000 ms, max 600000)
  and returns `{ value }` or `{ cancelled, reason }`.
