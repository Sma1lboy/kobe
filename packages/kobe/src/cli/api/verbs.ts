/**
 * Declarative verb table; see `api-cmd.ts` for the split rationale.
 */

import { DEFAULT_FEEDBACK_CATEGORY_SLUG } from "../../lib/feedback.ts"
import type { TaskStatus } from "../../types/task.ts"
import { F, FANOUT_CAP } from "./flags.ts"
import { handlePtyList, simpleRpc } from "./handler-helpers.ts"
import { add } from "./handlers-add.ts"
import { AGENT_TURNS_VERB } from "./handlers-agent-turns.ts"
import { DIGEST_VERB } from "./handlers-digest.ts"
import { ENGINE_LIST_VERB, SET_COMMAND_VERB } from "./handlers-engines.ts"
import { collect, feedback } from "./handlers-fanout.ts"
import { INSPECT_VERB } from "./handlers-inspect.ts"
import { PANE_CLOSE_VERB, PANE_VERB } from "./handlers-pane.ts"
import {
  DISPATCH_VERB,
  adopt,
  archive,
  deleteTask,
  getTask,
  land,
  list,
  note,
  send,
  setActive,
} from "./handlers-tasks.ts"
import { READ_OUTPUT_VERB } from "./read-output.ts"
import { fullSchema, groupSchema, schemaIndex, verbSchema } from "./schema.ts"
import { ApiError, type FlagSpec, type VerbContext, type VerbSpec } from "./types.ts"
import { ROUTINE_VERBS } from "./verbs-automations.ts"
import { ISSUE_VERBS } from "./verbs-issues.ts"
import { WORK_ITEM_VERBS } from "./verbs-work-items.ts"

/**
 * The `schema` verb's handler — LEVELED so it never dumps everything by
 * default:
 *   - no flags  → compact index (groups + verb names + summaries, NO flags)
 *   - --verb N  → one verb's full flag detail
 *   - --group G → the verbs in one group (compact)
 *   - --all     → the complete spec (every verb AND every flag)
 *
 * Lives HERE (not in `./schema.ts`, which owns the render functions this
 * calls) because it's referenced inside the {@link VERBS} array literal
 * below, which is evaluated at module-load time — a handler imported from a
 * module that itself imports `VERBS` back from here would still be
 * `undefined` at that point (load-order circular-import hazard).
 */
async function handleSchema(ctx: VerbContext): Promise<unknown> {
  const verbName = ctx.args.str("verb")
  if (verbName) {
    const v = findVerb(verbName)
    if (!v) throw new ApiError(`unknown verb: ${verbName}`, "BAD_VERB")
    return verbSchema(v)
  }
  const group = ctx.args.str("group")
  if (group) return groupSchema(group)
  if (ctx.args.bool("all")) return fullSchema()
  return schemaIndex()
}

/** Allowed `--status` values, mirrored from {@link TaskStatus}. */
const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "in_progress", "in_review", "done", "canceled", "error"]

/** Output the alias → canonical map so callers (and the schema) stay in sync. */
export const VERB_ALIASES: Readonly<Record<string, string>> = { "spawn-task": "add" }

/**
 * Verbs that were REMOVED, mapped to the argv that replaces them.
 *
 * Deliberately not aliases: `fan-out` folded into `add --count` and
 * `set-vendor` became `set-command`, and both changed their flag contract in
 * the process — an alias would silently accept the old flags and do
 * something subtly different. A retired verb instead fails loud with
 * `UNKNOWN_VERB` plus the `nextCommandArgs` an agent can run verbatim, which
 * is the same self-healing contract every other high-traffic rejection uses.
 */
export const RETIRED_VERBS: Readonly<Record<string, { hint: string; nextCommandArgs: readonly string[] }>> = {
  "fan-out": {
    hint: "fan-out was folded into `add`: pass --count N (or --agents claude:2,codex:1) to spawn N parallel tasks of one prompt",
    nextCommandArgs: ["api", "add", "--help"],
  },
  "set-vendor": {
    hint: "set-vendor was replaced by `set-command`, which takes the engine's raw launch command (an engine id from `engine-list`, or a full command line)",
    nextCommandArgs: ["api", "set-command", "--help"],
  },
}

/**
 * Verb groups for LEVELED exploration. An agent reads the compact index
 * (groups + verb summaries), then drills into one verb or one group —
 * instead of slurping every flag of every verb and polluting its context.
 */
export const VERB_GROUPS: Readonly<Record<string, readonly string[]>> = {
  discover: ["schema", "engine-list"],
  read: ["list", "get-task", "collect", "digest", "agent-turns", "pty-list", "read-output", "inspect"],
  create: ["add"],
  drive: ["send", "dispatch", "note", "note-list", "set-active", "pane-open", "pane-close", "notify"],
  edit: ["rename", "set-branch", "set-command", "set-status"],
  issues: ["issue-list", "issue-create", "issue-set-status", "issue-update"],
  workitems: ["workitem-list", "workitem-start"],
  routine: [
    "routine-list",
    "routine-create",
    "routine-update",
    "routine-set-enabled",
    "routine-delete",
    "routine-run-now",
    "routine-runs",
  ],
  lifecycle: ["archive", "pin", "land", "delete"],
  worktree: ["ensure-worktree", "adopt", "discover-adoptable"],
  feedback: ["feedback"],
}

// VERBS — ordered for help readability: discovery, reads, create, drive, edit,
// lifecycle, worktree. Every entry binds ONE verb's spec to its handler; the
// spec half feeds schema + --help + validation, the handler half runs against
// the injected VerbContext.
export const VERBS: readonly VerbSpec[] = [
  {
    name: "schema",
    summary:
      "Explore the API. Default = a COMPACT index (groups + verb summaries, no flags). Drill in with --verb / --group; --all for the full spec.",
    flags: [
      { name: "verb", type: "string", placeholder: "NAME", description: "Full flag detail for ONE verb." },
      { name: "group", type: "string", placeholder: "G", description: "List the verbs in one group (compact)." },
      {
        name: "all",
        type: "bool",
        description: "The COMPLETE spec — every verb AND every flag (large; avoid by default).",
      },
    ],
    offline: true,
    handler: handleSchema,
  },
  { name: "list", summary: "List all tasks (incl. archived). Returns { tasks }.", flags: [], handler: list },
  {
    name: "get-task",
    summary:
      "Read one task's metadata + terminal tabs. `.running` = any hosted engine tab is live; `.tabs[]` (id/kind/vendor/liveVendor/lastTitle/alive) is the discovery read for `send --tab tab-N`; `.task.dispatcher` = the Rove session (task+tab) that created it, when one did.",
    flags: [F.taskId()],
    handler: getTask,
  },
  {
    name: "add",
    summary: `Create a task (shows in the sidebar immediately). With --prompt it also starts the engine and delivers it. PARALLEL ATTEMPTS: --count N spawns N sibling tasks of the SAME prompt, each in its own worktree/branch (--agents claude:2,codex:1 for a mixed fleet); capped at ${FANOUT_CAP}, prefer 3-4. Does NOT steal focus — pass --activate to make it the active task. Alias: spawn-task.`,
    flags: [
      F.repo(),
      F.title(),
      {
        name: "branch",
        type: "string",
        placeholder: "B",
        description:
          "Explicit branch name (else auto-derived from the title, following the repo's own branch-naming convention). Single task only.",
      },
      { name: "base-branch", type: "string", placeholder: "B", description: "Base ref the worktree branches from." },
      F.command(),
      {
        name: "count",
        type: "int",
        placeholder: "N",
        description: `Spawn N sibling tasks of one prompt (parallel attempts, cap ${FANOUT_CAP}). Requires --prompt.`,
      },
      {
        name: "agents",
        type: "string",
        placeholder: "claude:2,codex:1",
        description:
          "Per-ENGINE counts for a mixed parallel round (alternative to --count). Engine ids only — see `engine-list`.",
      },
      {
        name: "status",
        type: "enum",
        values: TASK_STATUSES,
        default: "backlog",
        description: "Initial lifecycle status.",
      },
      { name: "pin", type: "bool", description: "Pin the task to the top of the sidebar." },
      {
        name: "activate",
        type: "bool",
        default: "false",
        description: "Make this the active task (pulls every mounted TUI's Tasks-pane focus). Off by default.",
      },
      F.prompt(
        false,
        "Optional first message — when set, materializes the worktree, starts the engine, and pastes it. Required with --count/--agents.",
      ),
    ],
    handler: add,
  },
  ENGINE_LIST_VERB,
  {
    name: "send",
    summary:
      "Paste a follow-up prompt into a task's running engine (one full turn). Without --task-id, a task spawned from another Rove session replies to its dispatcher's tab (then that task's live canonical engine; nothing alive = DISPATCHER_UNREACHABLE, never a silent spawn); otherwise the active task. Sent from inside another Rove task ($ROVE_TASK_ID), the prompt is prefixed with [KOBE PEER] provenance — who sent it and how to reply (tab-precise) — so agent-to-agent messaging needs no coordinator.",
    flags: [
      F.taskId(false),
      F.prompt(true, "Text pasted + submitted into the engine pane."),
      {
        name: "tab",
        type: "string",
        required: false,
        placeholder: "TAB",
        description:
          'Tab addressing: "new" spawns the prompt in a fresh engine tab; "tab-N" delivers to that exact alive tab (error when dead/absent). Omitted = the canonical engine tab.',
      },
      {
        ...F.command(),
        description:
          "Engine launch command for a `--tab new` tab — the API twin of the TUI's ctrl+e pick. Lets one worktree run two agents on the same files (e.g. hand the stuck work to codex without leaving the branch). An engine id from `engine-list` or a full command line; pinned to that tab, so it survives restarts and a later set-command on the task. Only valid with --tab new.",
      },
      {
        name: "plain",
        type: "bool",
        required: false,
        description: "Deliver the prompt verbatim — skip the [KOBE PEER] provenance prefix.",
      },
    ],
    handler: send,
  },
  DISPATCH_VERB,
  {
    name: "note",
    summary:
      "File a one-line field note — a resolved, repo-level gotcha worth sharing. Appended to the repo's durable note store (every future session on this repo starts with it) and forwarded to the dispatcher session for live relay (docs/design/dispatcher.md).",
    flags: [
      F.taskId(true),
      {
        name: "text",
        type: "string",
        required: true,
        placeholder: "TEXT",
        description: "One line: the verified conclusion another session could act on.",
      },
    ],
    handler: note,
  },
  {
    name: "note-list",
    summary: "Read a repo's accumulated field notes, newest first. Returns { notes }.",
    flags: [F.repo(true)],
    handler: (ctx) => simpleRpc(ctx, "note.list", { repo: ctx.args.requirePath("repo") }),
  },
  PANE_VERB,
  PANE_CLOSE_VERB,
  {
    name: "feedback",
    summary: "Create a GitHub Discussion in the Rove repo's Feedback category through `gh`.",
    flags: [
      { name: "title", type: "string", required: true, placeholder: "T", description: "Discussion title." },
      { name: "body", type: "string", required: true, placeholder: "TEXT", description: "Discussion body." },
      {
        name: "category",
        type: "string",
        default: DEFAULT_FEEDBACK_CATEGORY_SLUG,
        placeholder: "SLUG",
        description: "Discussion category slug.",
      },
    ],
    offline: true,
    handler: feedback,
  },
  ...ISSUE_VERBS,
  ...ROUTINE_VERBS,
  ...WORK_ITEM_VERBS,
  {
    name: "notify",
    summary:
      "Show a toast in every attached Rove UI — broadcast over the daemon's notice.event channel. Agents/scripts use it to surface 'done / needs input / error' moments without touching the task's session.",
    flags: [
      {
        name: "title",
        type: "string",
        required: true,
        placeholder: "TEXT",
        description: "Toast text (one line).",
      },
      {
        name: "kind",
        type: "string",
        default: "done",
        placeholder: "KIND",
        description:
          'Free-form kind tag. "done", "needs_input" and "error" get the TUI\'s severity styling/unread mark; any other value renders neutrally.',
      },
      F.taskId(false),
      {
        name: "source",
        type: "string",
        placeholder: "TAG",
        description: "Free-form origin tag (e.g. an agent name) recorded on the event.",
      },
    ],
    handler: async (ctx) => {
      return simpleRpc(ctx, "notice.send", {
        title: ctx.args.str("title"),
        kind: ctx.args.str("kind") ?? "done",
        taskId: ctx.args.str("task-id"),
        source: ctx.args.str("source"),
      })
    },
  },
  {
    name: "prompt",
    summary:
      "Ask the human for a line of text through the attached TUI's input dialog (plugins' host-provided prompt). Blocks until answered, cancelled, or timed out; returns { value } or { cancelled, reason }.",
    flags: [
      {
        name: "title",
        type: "string",
        required: true,
        placeholder: "TEXT",
        description: "Dialog title (shown verbatim).",
      },
      { name: "placeholder", type: "string", placeholder: "TEXT", description: "Input placeholder." },
      { name: "initial", type: "string", placeholder: "TEXT", description: "Pre-filled input value." },
      {
        name: "timeout",
        type: "string",
        placeholder: "MS",
        description: "Give up after this many milliseconds (default 120000, max 600000).",
      },
    ],
    handler: async (ctx) => {
      const timeoutRaw = ctx.args.str("timeout")
      const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined
      return simpleRpc(ctx, "ui.prompt", {
        title: ctx.args.str("title"),
        placeholder: ctx.args.str("placeholder"),
        initial: ctx.args.str("initial"),
        ...(timeoutMs && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      })
    },
  },
  {
    name: "pty-list",
    summary:
      "List hosted PTY sessions (key, alive, pid, command, live OSC window title). Empty when no pty host runs. Returns { sessions }.",
    flags: [],
    offline: true,
    handler: handlePtyList,
  },
  {
    name: "collect",
    summary:
      "Read-only comparison snapshot of several tasks: identity, branch, lineage (.dispatcher, .groupId), .running, per-tab .tabs (same join as get-task — pick a `send --tab` target without a second hop), uncommitted .changes, and committed .base (ahead count + diffstat vs the base branch).",
    flags: [
      { name: "task-ids", type: "csv", placeholder: "a,b,c", description: "Comma-separated task ids." },
      F.repo(false),
    ],
    handler: collect,
  },
  // The ruler: an aggregate read over recent tasks + routine runs. Spec +
  // handler in ./handlers-digest.ts.
  DIGEST_VERB,
  AGENT_TURNS_VERB,
  // Production diagnostics aggregate (daemon activity registry + pty
  // sessions with live foreground walk + persisted tab snapshots). Spec +
  // handler in ./handlers-inspect.ts.
  INSPECT_VERB,
  READ_OUTPUT_VERB,
  {
    name: "rename",
    summary: "Set a task's title.",
    flags: [F.taskId(), { name: "title", type: "string", required: true, placeholder: "T", description: "New title." }],
    handler: (ctx) =>
      simpleRpc(ctx, "task.rename", { taskId: ctx.args.require("task-id"), title: ctx.args.require("title") }),
  },
  {
    name: "set-branch",
    summary: "Rename a task's branch (git branch -m if materialized, else recorded).",
    flags: [
      F.taskId(),
      { name: "branch", type: "string", required: true, placeholder: "B", description: "New branch name." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "task.setBranch", { taskId: ctx.args.require("task-id"), branch: ctx.args.require("branch") }),
  },
  SET_COMMAND_VERB,
  {
    name: "set-status",
    summary: "Set a task's lifecycle status.",
    flags: [
      F.taskId(),
      { name: "status", type: "enum", required: true, values: TASK_STATUSES, description: "New status." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "task.status", {
        taskId: ctx.args.require("task-id"),
        status: ctx.args.requireEnum<TaskStatus>("status"),
      }),
  },
  {
    name: "archive",
    summary: "Archive (or with --archived=false, unarchive) a task. Non-destructive: worktree/branch/history stay.",
    flags: [
      F.taskId(),
      { name: "archived", type: "bool", default: "true", description: "true to archive, false to unarchive." },
    ],
    handler: archive,
  },
  {
    name: "pin",
    summary: "Pin (or with --pinned=false, unpin) a task to the top of the sidebar.",
    flags: [F.taskId(), { name: "pinned", type: "bool", default: "true", description: "true to pin, false to unpin." }],
    handler: (ctx) =>
      simpleRpc(ctx, "task.pin", {
        taskId: ctx.args.require("task-id"),
        pinned: ctx.args.bool("pinned") ?? true,
      }),
  },
  {
    name: "set-active",
    summary: "Set the shared active task (the focus every Tasks pane highlights). Pass --none to clear.",
    flags: [
      F.taskId(false),
      { name: "none", type: "bool", description: "Clear the active task instead of setting one." },
    ],
    handler: setActive,
  },
  {
    name: "ensure-worktree",
    summary: "Materialize a task's git worktree on disk now (without starting an engine). Returns { worktreePath }.",
    flags: [F.taskId()],
    handler: (ctx) => simpleRpc(ctx, "task.ensureWorktree", { taskId: ctx.args.require("task-id") }),
  },
  {
    name: "land",
    summary:
      "Merge a task's branch back into its base repo's current branch. Refuses a dirty base checkout; on conflict, aborts and returns the conflicted files (resolve by hand). Returns { landedOn, commit }.",
    flags: [
      F.taskId(),
      {
        name: "strategy",
        type: "enum",
        values: ["merge", "squash"],
        default: "merge",
        description: "merge (--no-ff) or squash into one commit.",
      },
      { name: "delete-branch", type: "bool", description: "Delete the task's branch after a successful land." },
      { name: "then-archive", type: "bool", description: "Archive the task after a successful land." },
      {
        name: "remove-worktree",
        type: "bool",
        description:
          "Remove the task's worktree after a successful land (the branch stays). Dirty worktrees, the base checkout, and the caller's own worktree are refused — the outcome is reported in the result's `worktree` field, never thrown.",
      },
    ],
    handler: land,
  },
  {
    name: "delete",
    summary:
      "Remove a task and its worktree; the git branch stays unless --delete-branch. Needs --force on a dirty worktree.",
    flags: [
      F.taskId(),
      {
        name: "force",
        type: "bool",
        description: "Delete even with uncommitted changes (never implies --delete-branch).",
      },
      { name: "delete-branch", type: "bool", description: "Also delete the task's git branch (default: keep it)." },
    ],
    handler: deleteTask,
  },
  {
    name: "discover-adoptable",
    summary: "List existing git worktrees in a repo not yet tracked as Rove tasks. Returns { worktrees }.",
    flags: [F.repo()],
    handler: (ctx) => simpleRpc(ctx, "worktree.discoverAdoptable", { repo: ctx.args.requirePath("repo") }),
  },
  {
    name: "adopt",
    summary: "Import an existing git worktree as a Rove task. Returns { task }.",
    flags: [
      F.repo(),
      {
        name: "worktree",
        type: "string",
        required: true,
        placeholder: "PATH",
        description: "Path of the worktree to adopt.",
      },
      { name: "branch", type: "string", placeholder: "B", description: "Branch override (else the worktree's own)." },
      F.command(),
      F.title(),
    ],
    handler: adopt,
  },
]

/** Verb names in canonical order (schema/help/tests). */
export const API_VERBS = VERBS.map((v) => v.name)

export function findVerb(name: string): VerbSpec | undefined {
  const canonical = VERB_ALIASES[name] ?? name
  return VERBS.find((v) => v.name === canonical)
}
