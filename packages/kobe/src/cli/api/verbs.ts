/**
 * The declarative verb table — {@link VERBS} is the single source of truth
 * binding each verb's spec (name, summary, flags) to its handler. Split
 * out of `api-cmd.ts` (see that file's header for the full rationale).
 */

import { DEFAULT_FEEDBACK_CATEGORY_SLUG } from "../../lib/feedback.ts"
import type { TaskStatus } from "../../types/task.ts"
import { ALL_VENDORS, type VendorId } from "../../types/vendor.ts"
import { FANOUT_CAP } from "./flags.ts"
import { simpleRpc } from "./handler-helpers.ts"
import { collect, fanOut, feedback } from "./handlers-fanout.ts"
import {
  add,
  adopt,
  archive,
  deleteTask,
  dispatch,
  getTask,
  issueUpdate,
  land,
  list,
  note,
  send,
  setActive,
} from "./handlers-tasks.ts"
import { fullSchema, groupSchema, schemaIndex, verbSchema } from "./schema.ts"
import { ApiError, type FlagSpec, type VerbContext, type VerbSpec } from "./types.ts"

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
/**
 * `pty-list` — inventory of the standalone pty host's sessions (key, pid,
 * command, live OSC window title — the same "实时进程名" stream the TUI tab
 * strip shows). Talks to the PTY HOST socket, not the daemon (offline verb),
 * and never spawns a host: no host running simply means no sessions.
 */
async function handlePtyList(): Promise<unknown> {
  const [{ KobeDaemonClient }, { defaultPtyHostSocketPath }] = await Promise.all([
    import("@sma1lboy/kobe-daemon/client"),
    import("@sma1lboy/kobe-daemon/daemon/paths"),
  ])
  const client = new KobeDaemonClient(defaultPtyHostSocketPath())
  try {
    await client.connect()
    return await client.request("pty.list", {})
  } catch {
    return { sessions: [] }
  } finally {
    client.close()
  }
}

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
const ISSUE_STATUSES = ["open", "doing", "hold", "done"] as const
type IssueStatus = (typeof ISSUE_STATUSES)[number]

// Reusable flag fragments.
const F = {
  repo: (required = true): FlagSpec => ({
    name: "repo",
    type: "string",
    required,
    placeholder: "PATH",
    description: "Repo root (git toplevel). Relative paths resolve against $PWD.",
  }),
  taskId: (required = true): FlagSpec => ({
    name: "task-id",
    type: "string",
    required,
    placeholder: "ID",
    description: "Target task id (from `list` / `add`).",
  }),
  vendor: (): FlagSpec => ({
    name: "vendor",
    type: "enum",
    values: ALL_VENDORS,
    placeholder: "V",
    description: "Engine vendor for the task.",
  }),
  title: (): FlagSpec => ({ name: "title", type: "string", placeholder: "T", description: "Human task title." }),
  prompt: (required: boolean, desc: string): FlagSpec => ({
    name: "prompt",
    type: "string",
    required,
    placeholder: "TEXT",
    description: desc,
  }),
}

/** Output the alias → canonical map so callers (and the schema) stay in sync. */
export const VERB_ALIASES: Readonly<Record<string, string>> = { "spawn-task": "add" }

/**
 * Verb groups for LEVELED exploration. An agent reads the compact index
 * (groups + verb summaries), then drills into one verb or one group —
 * instead of slurping every flag of every verb and polluting its context.
 */
export const VERB_GROUPS: Readonly<Record<string, readonly string[]>> = {
  discover: ["schema"],
  read: ["list", "get-task", "collect", "pty-list"],
  create: ["add", "fan-out"],
  drive: ["send", "dispatch", "note", "set-active"],
  edit: ["rename", "set-branch", "set-vendor", "set-status"],
  issues: ["issue-list", "issue-create", "issue-set-status", "issue-update"],
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
    summary: "Read one task's metadata. `.running` = its hosted engine session is live.",
    flags: [F.taskId()],
    handler: getTask,
  },
  {
    name: "add",
    summary:
      "Create a task (shows in the sidebar immediately). With --prompt it also starts the engine and delivers it. Does NOT steal focus — pass --activate to make it the active task. Alias: spawn-task.",
    flags: [
      F.repo(),
      F.title(),
      {
        name: "branch",
        type: "string",
        placeholder: "B",
        description: "Explicit branch name (else auto kobe/<slug>-<id>).",
      },
      { name: "base-branch", type: "string", placeholder: "B", description: "Base ref the worktree branches from." },
      F.vendor(),
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
        "Optional first message — when set, materializes the worktree, starts the engine, and pastes it.",
      ),
    ],
    handler: add,
  },
  {
    name: "fan-out",
    summary: `Spawn N tasks of ONE prompt in a single call (parallel attempts). Capped at ${FANOUT_CAP}.`,
    flags: [
      F.repo(),
      F.prompt(true, "Shared prompt delivered to every spawned task."),
      { name: "count", type: "int", placeholder: "N", description: "Number of tasks of one vendor (with --vendor)." },
      {
        name: "agents",
        type: "string",
        placeholder: "claude:2,codex:1",
        description: "Per-vendor counts (alternative to --count).",
      },
      F.vendor(),
      F.title(),
      { name: "base-branch", type: "string", placeholder: "B", description: "Base ref for every worktree." },
    ],
    handler: fanOut,
  },
  {
    name: "send",
    summary: "Paste a follow-up prompt into a task's running engine (one full turn). Defaults to the active task.",
    flags: [F.taskId(false), F.prompt(true, "Text pasted + submitted into the engine pane.")],
    handler: send,
  },
  {
    name: "dispatch",
    summary:
      "Route text into a task's live session via the daemon's session.deliver channel. The dispatcher's messenger (docs/design/dispatcher.md); unlike `send`, it requires an already-hosted session.",
    flags: [F.taskId(true), F.prompt(true, "Text delivered into the task's engine session.")],
    handler: dispatch,
  },
  {
    name: "note",
    summary:
      "File a one-line field note — a resolved, repo-level gotcha worth sharing. kobe forwards it to the repo's dispatcher session (the main session), which relays it to the in-flight tasks that benefit (docs/design/dispatcher.md).",
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
    name: "feedback",
    summary: "Create a GitHub Discussion in the kobe repo's Feedback category through `gh`.",
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
  {
    name: "issue-list",
    summary: "List daemon-owned issues for a repo.",
    flags: [F.repo()],
    handler: (ctx) => simpleRpc(ctx, "issue.list", { repoRoot: ctx.args.requirePath("repo") }),
  },
  {
    name: "issue-create",
    summary: "Create a daemon-owned issue for a repo.",
    flags: [
      F.repo(),
      { name: "title", type: "string", required: true, placeholder: "T", description: "Issue title." },
      { name: "body", type: "string", placeholder: "TEXT", description: "Issue body." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "issue.mutate", {
        repoRoot: ctx.args.requirePath("repo"),
        op: { type: "create", title: ctx.args.require("title"), body: ctx.args.str("body") },
      }),
  },
  {
    name: "issue-set-status",
    summary: "Set a daemon-owned issue's status.",
    flags: [
      F.repo(),
      { name: "id", type: "int", required: true, placeholder: "N", description: "Issue id." },
      { name: "status", type: "enum", required: true, values: ISSUE_STATUSES, description: "New issue status." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "issue.mutate", {
        repoRoot: ctx.args.requirePath("repo"),
        op: { type: "setStatus", id: ctx.args.int("id"), status: ctx.args.requireEnum<IssueStatus>("status") },
      }),
  },
  {
    name: "issue-update",
    summary: "Update a daemon-owned issue's title and/or body.",
    flags: [
      F.repo(),
      { name: "id", type: "int", required: true, placeholder: "N", description: "Issue id." },
      { name: "title", type: "string", placeholder: "T", description: "New title." },
      { name: "body", type: "string", placeholder: "TEXT", description: "New body." },
    ],
    handler: issueUpdate,
  },
  {
    name: "notify",
    summary:
      "Show a toast in every attached kobe UI — broadcast over the daemon's notice.event channel. Agents/scripts use it to surface 'done / needs input / error' moments without touching the task's session.",
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
    name: "pty-list",
    summary:
      "List hosted PTY sessions (key, alive, pid, command, live OSC window title). Empty when no pty host runs. Returns { sessions }.",
    flags: [],
    offline: true,
    handler: handlePtyList,
  },
  {
    name: "collect",
    summary: "Read-only comparison snapshot of several tasks (identity, branch, .running, uncommitted .changes).",
    flags: [
      { name: "task-ids", type: "csv", placeholder: "a,b,c", description: "Comma-separated task ids." },
      F.repo(false),
    ],
    handler: collect,
  },
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
  {
    name: "set-vendor",
    summary: "Change a task's engine vendor (takes effect on next session rebuild).",
    flags: [F.taskId(), { ...F.vendor(), required: true }],
    handler: (ctx) =>
      simpleRpc(ctx, "task.setVendor", {
        taskId: ctx.args.require("task-id"),
        vendor: ctx.args.requireEnum<VendorId>("vendor"),
      }),
  },
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
    ],
    handler: land,
  },
  {
    name: "delete",
    summary:
      "Permanently remove a task (and its worktree). DESTRUCTIVE — prefer `archive`. Needs --force on a dirty worktree.",
    flags: [F.taskId(), { name: "force", type: "bool", description: "Delete even with uncommitted changes." }],
    handler: deleteTask,
  },
  {
    name: "discover-adoptable",
    summary: "List existing git worktrees in a repo not yet tracked as kobe tasks. Returns { worktrees }.",
    flags: [F.repo()],
    handler: (ctx) => simpleRpc(ctx, "worktree.discoverAdoptable", { repo: ctx.args.requirePath("repo") }),
  },
  {
    name: "adopt",
    summary: "Import an existing git worktree as a kobe task. Returns { task }.",
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
      F.vendor(),
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
