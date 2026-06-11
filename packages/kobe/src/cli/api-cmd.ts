/**
 * `kobe api <verb>` — the scriptable control surface for agents driving
 * kobe from a shell (Bash tool / cron / arbitrary scripts).
 *
 * Each invocation is a short-lived process: connect to (or auto-start) the
 * daemon, do the work, print a JSON object to stdout, exit. Designed for
 * fan-out AND full task lifecycle control — it exposes (almost) everything
 * the daemon can do, so an agent never has to drop into the TUI for a
 * scripted operation.
 *
 * ## Self-describing (so an agent can EXPLORE the surface)
 *
 * The verb table {@link VERBS} is the single source of truth: each entry
 * binds one verb's spec (name, summary, flags) to its handler, and the spec
 * half drives the `schema` verb (machine-readable JSON of every verb +
 * flag), per-verb `--help`, and flag validation (required / enum /
 * unknown-flag rejection). An agent runs `kobe api schema` once and knows
 * the whole API — names, types, which flags are required, allowed enum
 * values — without parsing prose. Add a verb to {@link VERBS} and its help,
 * schema entry, and validation all come for free.
 *
 * ## Handler seam (so verbs are unit-testable)
 *
 * Handlers receive a {@link VerbContext}: spec-typed flag access
 * ({@link VerbArgs}, derived from the verb's own FlagSpecs — no ad hoc
 * re-validation inside handlers), the narrow daemon RPC surface
 * ({@link DaemonRpc} — a fake that records requests stands in for the
 * socket in tests), and the side-effect seam ({@link ApiRuntime} — tmux /
 * git / repo-init). Daemon connect/close lives in `./daemon-session.ts`.
 *
 * ## Output contract
 *   - success → one JSON object to stdout, `\n` terminated, exit 0
 *   - error   → `{ "error": { "message", "code" } }` to stderr, exit ≠ 0
 *   - `--pretty` → indent stdout JSON (humans only)
 *   - `--help`   → render that verb's usage to stdout, exit 0
 *
 * The daemon is auto-started if it is not already running, so an agent
 * script does not have to babysit it (read-only verbs like `schema` skip
 * the daemon entirely).
 */

import { resolve } from "node:path"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { DEFAULT_FEEDBACK_CATEGORY_SLUG, submitFeedback } from "../lib/feedback.ts"
import type { ResolvedRepoInit } from "../state/repo-init.ts"
import { killSession, sessionExists, switchClientBeforeKill, tmuxSessionName } from "../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../tmux/prompt-delivery.ts"
import type { EnsureSessionOpts } from "../tui/panes/terminal/tmux.ts"
import type { TaskStatus } from "../types/task.ts"
import { ALL_VENDORS, type VendorId } from "../types/vendor.ts"
import { CURRENT_VERSION } from "../version.ts"
import { type DaemonRpc, type DaemonSession, openDaemonSession } from "./daemon-session.ts"

/** Bumped when the verb/flag shape changes incompatibly. Agents can gate on it. */
export const API_SCHEMA_VERSION = 2

/** Safety cap on a single fan-out so a typo can't spawn a runaway fleet. */
export const FANOUT_CAP = 10

/** Allowed `--status` values, mirrored from {@link TaskStatus}. */
const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "in_progress", "in_review", "done", "canceled", "error"]

type Flags = Map<string, string>

interface ParsedArgs {
  readonly flags: Flags
  readonly pretty: boolean
  readonly help: boolean
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

// ── Declarative verb + flag specs (single source of truth) ───────────────────

type FlagType = "string" | "int" | "bool" | "enum" | "csv"

interface FlagSpec {
  readonly name: string
  readonly type: FlagType
  readonly required?: boolean
  readonly description: string
  /** Allowed values when `type === "enum"`. */
  readonly values?: readonly string[]
  /** Default shown in schema/help (informational; not auto-applied). */
  readonly default?: string
  /** Metavar for help/schema, e.g. PATH / ID / TEXT. */
  readonly placeholder?: string
}

/**
 * What a verb handler runs against. Everything here is injectable so a
 * handler's LOGIC is unit-testable without a daemon socket or a tmux
 * server: `client` accepts any {@link DaemonRpc} (tests pass a fake that
 * records requests), `runtime` carries the side-effecting operations
 * (tmux liveness, prompt delivery, git worktree reads).
 */
interface VerbContext {
  /** Spec-typed flag access — coercion + requiredness derived from the verb's own {@link FlagSpec}s. */
  readonly args: VerbArgs
  /** Daemon RPC surface; `null` only for `offline` verbs (guard with {@link daemonOf}). */
  readonly client: DaemonRpc | null
  /** Side-effect seam (tmux / git / repo-init) — swapped for a fake in unit tests. */
  readonly runtime: ApiRuntime
}

type VerbHandler = (ctx: VerbContext) => Promise<unknown>

interface VerbSpec {
  readonly name: string
  readonly summary: string
  readonly flags: readonly FlagSpec[]
  /** Verbs that don't need the daemon (e.g. `schema`). */
  readonly offline?: boolean
  readonly handler: VerbHandler
}

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
const VERB_ALIASES: Readonly<Record<string, string>> = { "spawn-task": "add" }

/**
 * Verb groups for LEVELED exploration. An agent reads the compact index
 * (groups + verb summaries), then drills into one verb or one group —
 * instead of slurping every flag of every verb and polluting its context.
 */
const VERB_GROUPS: Readonly<Record<string, readonly string[]>> = {
  discover: ["schema"],
  read: ["list", "get-task", "collect"],
  create: ["add", "fan-out"],
  drive: ["send", "set-active"],
  edit: ["rename", "set-branch", "set-vendor", "set-status"],
  lifecycle: ["archive", "pin", "delete"],
  worktree: ["ensure-worktree", "adopt", "discover-adoptable"],
  feedback: ["feedback"],
}

function groupOf(verbName: string): string {
  for (const [group, names] of Object.entries(VERB_GROUPS)) {
    if (names.includes(verbName)) return group
  }
  return "other"
}

/**
 * The `schema` handler — LEVELED so it never dumps everything by default:
 *   - no flags  → compact index (groups + verb names + summaries, NO flags)
 *   - --verb N  → one verb's full flag detail
 *   - --group G → the verbs in one group (compact)
 *   - --all     → the complete spec (every verb AND every flag)
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

// VERBS — ordered for help readability: discovery, reads, create, drive, edit,
// lifecycle, worktree. Every entry binds ONE verb's spec to its handler; the
// spec half feeds schema + --help + validation, the handler half runs against
// the injected VerbContext.
const VERBS: readonly VerbSpec[] = [
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
    summary: "Read one task's metadata. `.running` = its tmux session is live.",
    flags: [F.taskId()],
    handler: getTask,
  },
  {
    name: "add",
    summary:
      "Create a task (shows in the sidebar immediately). With --prompt it also starts the engine and delivers it. Alias: spawn-task.",
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
export type ApiVerb = (typeof API_VERBS)[number]

function findVerb(name: string): VerbSpec | undefined {
  const canonical = VERB_ALIASES[name] ?? name
  return VERBS.find((v) => v.name === canonical)
}

// ── Flag parsing + spec-driven validation ────────────────────────────────────

/**
 * Parse argv into a flag map + `--pretty` / `--help` booleans. Accepts both
 * `--key=value` and `--key value`. `booleanFlags` (from the verb spec) may be
 * given as standalone presence flags (`--force` ⇒ "true"); without it, only
 * `--pretty` / `--help` are standalone. Unknown forms throw BAD_FLAG.
 */
export function parseFlags(argv: readonly string[], booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const flags = new Map<string, string>()
  let pretty = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--") && arg !== "-h") {
      throw new ApiError(`unexpected positional arg: ${arg}`, "BAD_FLAG")
    }
    if (arg === "-h") {
      help = true
      continue
    }
    const eq = arg.indexOf("=")
    if (eq !== -1) {
      const key = arg.slice(2, eq)
      const value = arg.slice(eq + 1)
      if (key === "pretty") pretty = value !== "false" && value !== "0"
      else if (key === "help") help = value !== "false" && value !== "0"
      else flags.set(key, value)
      continue
    }
    const key = arg.slice(2)
    if (key === "pretty") {
      pretty = true
      continue
    }
    if (key === "help") {
      help = true
      continue
    }
    // A boolean verb flag with no value is a presence flag (`--force`).
    if (booleanFlags.has(key)) {
      flags.set(key, "true")
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      throw new ApiError(`flag --${key} requires a value`, "BAD_FLAG")
    }
    flags.set(key, next)
    i += 1
  }
  return { flags, pretty, help }
}

/** Reject flags not declared on the verb spec, and required flags that are missing. */
function validateAgainstSpec(verb: VerbSpec, flags: Flags): void {
  const known = new Set(verb.flags.map((f) => f.name))
  for (const key of flags.keys()) {
    if (!known.has(key)) {
      throw new ApiError(`unknown flag --${key} for "${verb.name}". Run \`kobe api ${verb.name} --help\``, "BAD_FLAG")
    }
  }
  for (const f of verb.flags) {
    if (f.required && !flags.get(f.name))
      throw new ApiError(`--${f.name} is required for "${verb.name}"`, "MISSING_FLAG")
    if (f.type === "enum" && f.values) {
      const raw = flags.get(f.name)
      if (raw !== undefined && !f.values.includes(raw)) {
        throw new ApiError(`--${f.name} must be one of ${f.values.join(", ")}`, "BAD_FLAG")
      }
    }
    if (f.type === "int") {
      const raw = flags.get(f.name)
      if (raw !== undefined) {
        const n = Number.parseInt(raw, 10)
        if (!Number.isInteger(n) || n <= 0) throw new ApiError(`--${f.name} must be a positive integer`, "BAD_FLAG")
      }
    }
  }
}

/**
 * Spec-typed flag access, built ONCE per invocation after
 * {@link validateAgainstSpec}. Each accessor derives its coercion from the
 * verb's own {@link FlagSpec} (enum values, bool/int shapes), so handlers
 * never re-declare what the spec already knows — and a handler reading a
 * flag its spec never declared is a programming error, caught loudly.
 */
class VerbArgs {
  constructor(
    private readonly verb: VerbSpec,
    private readonly flags: Flags,
  ) {}

  private spec(name: string): FlagSpec {
    const f = this.verb.flags.find((s) => s.name === name)
    if (!f) throw new Error(`internal: --${name} is not declared on verb "${this.verb.name}"`)
    return f
  }

  /** Optional string value; an empty string counts as absent. */
  str(name: string): string | undefined {
    this.spec(name)
    const v = this.flags.get(name)
    return v && v.length > 0 ? v : undefined
  }

  /** Required string value (MISSING_FLAG when absent). */
  require(name: string): string {
    const v = this.str(name)
    if (v === undefined) throw new ApiError(`--${name} is required`, "MISSING_FLAG")
    return v
  }

  /** Enum value, validated against the SPEC's declared `values`. */
  enumOf<T extends string>(name: string): T | undefined {
    const f = this.spec(name)
    const v = this.str(name)
    if (v === undefined) return undefined
    if (f.values && !f.values.includes(v)) {
      throw new ApiError(`--${name} must be one of ${f.values.join(", ")}`, "BAD_FLAG")
    }
    return v as T
  }

  /** Required enum value. */
  requireEnum<T extends string>(name: string): T {
    this.require(name)
    return this.enumOf<T>(name) as T
  }

  /** The shared `--vendor` flag, typed. */
  vendor(): VendorId | undefined {
    return this.enumOf<VendorId>("vendor")
  }

  /** Boolean flag (`true/1/yes` / `false/0/no`); undefined when absent. */
  bool(name: string): boolean | undefined {
    this.spec(name)
    const raw = this.str(name)
    if (raw === undefined) return undefined
    if (["true", "1", "yes"].includes(raw)) return true
    if (["false", "0", "no"].includes(raw)) return false
    throw new ApiError(`--${name} must be a boolean (true/false)`, "BAD_FLAG")
  }

  /** Positive-integer flag; undefined when absent. */
  int(name: string): number | undefined {
    this.spec(name)
    const raw = this.str(name)
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw, 10)
    if (!Number.isInteger(n) || n <= 0) throw new ApiError(`--${name} must be a positive integer`, "BAD_FLAG")
    return n
  }

  /** Optional PATH flag resolved against $PWD. */
  path(name: string): string | undefined {
    const v = this.str(name)
    return v === undefined ? undefined : resolve(process.cwd(), v)
  }

  /** Required PATH flag resolved against $PWD. */
  requirePath(name: string): string {
    return resolve(process.cwd(), this.require(name))
  }
}

/**
 * Parse a fan-out spec like `claude:2,codex:1` into a flat list with one
 * vendor entry per task to spawn (`[claude, claude, codex]`).
 */
export function parseAgentsSpec(spec: string): VendorId[] {
  const out: VendorId[] = []
  for (const part of spec.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) throw new ApiError(`--agents entry "${trimmed}" must be vendor:count`, "BAD_FLAG")
    const vendor = trimmed.slice(0, colon)
    if (!ALL_VENDORS.includes(vendor as VendorId)) {
      throw new ApiError(`--agents vendor "${vendor}" must be one of ${ALL_VENDORS.join(", ")}`, "BAD_FLAG")
    }
    const count = Number.parseInt(trimmed.slice(colon + 1), 10)
    if (!Number.isInteger(count) || count <= 0) {
      throw new ApiError(`--agents count for "${vendor}" must be a positive integer`, "BAD_FLAG")
    }
    for (let i = 0; i < count; i++) out.push(vendor as VendorId)
  }
  if (out.length === 0) throw new ApiError('--agents specified no agents (e.g. "claude:2,codex:1")', "BAD_FLAG")
  return out
}

// ── Schema (LEVELED) + help (all derived from VERBS) ─────────────────────────

const GLOBAL_FLAGS = [
  { name: "pretty", type: "bool", description: "Pretty-print stdout JSON." },
  { name: "help", type: "bool", description: "Show usage for the verb and exit." },
]

function flagJson(f: FlagSpec): unknown {
  return {
    name: f.name,
    type: f.type,
    required: f.required ?? false,
    ...(f.values ? { values: f.values } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    description: f.description,
  }
}

/** ONE verb, full detail (flags + types). The drill-in level. */
function verbSchema(v: VerbSpec): unknown {
  return {
    name: v.name,
    group: groupOf(v.name),
    summary: v.summary,
    offline: v.offline ?? false,
    flags: v.flags.map(flagJson),
  }
}

/** The COMPACT index: groups + verb names + summaries, but NO flags — so an
 *  agent can survey the surface cheaply, then drill in with --verb. */
function schemaIndex(): unknown {
  return {
    apiVersion: API_SCHEMA_VERSION,
    kobeVersion: CURRENT_VERSION,
    hint: "Compact index. Drill into ONE verb: `kobe api schema --verb <name>` (or `kobe api <verb> --help`). One group: `--group <g>`. Whole spec: `--all`.",
    groups: VERB_GROUPS,
    verbs: VERBS.map((v) => ({ name: v.name, group: groupOf(v.name), summary: v.summary })),
    globalFlags: GLOBAL_FLAGS,
    aliases: VERB_ALIASES,
  }
}

/** The verbs in ONE group (compact). */
function groupSchema(group: string): unknown {
  const names = VERB_GROUPS[group]
  if (!names) {
    throw new ApiError(`unknown group: ${group}. Groups: ${Object.keys(VERB_GROUPS).join(", ")}`, "BAD_FLAG")
  }
  return {
    group,
    verbs: names.map((n) => {
      const v = findVerb(n)
      return { name: n, summary: v?.summary ?? "" }
    }),
  }
}

/** The COMPLETE spec — every verb AND every flag. Opt-in via --all. */
function fullSchema(): unknown {
  return {
    apiVersion: API_SCHEMA_VERSION,
    kobeVersion: CURRENT_VERSION,
    output: {
      success: "one JSON object on stdout, newline-terminated, exit 0",
      error: '{"error":{"message","code"}} on stderr, exit != 0',
      pretty: "--pretty indents stdout JSON",
    },
    globalFlags: GLOBAL_FLAGS,
    aliases: VERB_ALIASES,
    groups: VERB_GROUPS,
    verbs: VERBS.map(verbSchema),
  }
}

/** Render one verb's flag signature, e.g. `--repo PATH [--title T] ...`. */
function flagSignature(verb: VerbSpec): string {
  return verb.flags
    .map((f) => {
      const meta =
        f.type === "enum" && f.values ? f.values.join("|") : (f.placeholder ?? (f.type === "bool" ? "" : "X"))
      const core = meta ? `--${f.name} ${meta}` : `--${f.name}`
      return f.required ? core : `[${core}]`
    })
    .join(" ")
}

/** Full `kobe api <verb> --help` text. */
export function verbHelp(verb: VerbSpec): string {
  const lines = [`kobe api ${verb.name} ${flagSignature(verb)}`.trimEnd(), "", verb.summary, ""]
  const alias = Object.entries(VERB_ALIASES).find(([, canon]) => canon === verb.name)?.[0]
  if (alias) lines.push(`Alias: ${alias}`, "")
  if (verb.flags.length > 0) {
    lines.push("Flags:")
    for (const f of verb.flags) {
      const req = f.required ? " (required)" : ""
      const def = f.default !== undefined ? ` [default: ${f.default}]` : ""
      const vals = f.type === "enum" && f.values ? ` {${f.values.join("|")}}` : ""
      lines.push(`  --${f.name}${vals}${req}${def}  ${f.description}`)
    }
    lines.push("")
  }
  lines.push("Global: [--pretty] [--help]")
  return lines.join("\n")
}

/** One-line-per-verb usage banner for `kobe api` with no/bad verb. */
export function apiUsage(): string {
  const rows = VERBS.map((v) => `  ${v.name.padEnd(18)} ${v.summary}`)
  return [
    "usage: kobe api <verb> [flags] [--pretty] [--help]",
    "",
    "Explore the full surface (names, flags, types) with:  kobe api schema",
    "",
    "verbs:",
    ...rows,
    "",
    "Output is one JSON object on stdout (exit 0); errors are JSON on stderr (exit != 0).",
  ].join("\n")
}

// ── stdout/stderr emit ───────────────────────────────────────────────────────

function emit(value: unknown, pretty: boolean): void {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  process.stdout.write(`${text}\n`)
}

function fail(message: string, code: string, exitCode = 1): never {
  process.stderr.write(`${JSON.stringify({ error: { message, code } })}\n`)
  process.exit(exitCode)
}

// ── Prompt delivery (shared by add / fan-out / send) ─────────────────────────

interface PromptTarget {
  readonly id: string
  readonly worktreePath: string
  readonly vendor?: VendorId
  readonly repo?: string
}

interface DeliveredPrompt {
  readonly session: string
  readonly pane: string
  readonly started: boolean
  readonly engineReady: boolean
}

/**
 * The tmux/engine operations {@link deliverPrompt} performs, injectable so
 * its decision logic (ensure-worktree fallback, fresh-session build,
 * explicit-prompt-wins-over-repo-init-prompt) is unit-testable without a
 * tmux server. The default lazily imports the heavy session builder so a
 * plain `kobe api list` never loads the TUI pane stack.
 */
interface PromptDeliveryOps {
  sessionExists(session: string): Promise<boolean>
  ensureSession(opts: EnsureSessionOpts): Promise<boolean>
  waitForEnginePane(session: string, fresh: boolean): Promise<{ pane: string; ready: boolean }>
  pasteAndSubmit(pane: string, text: string): Promise<void>
  resolveRepoInit(repoRoot: string, worktreePath: string): Promise<ResolvedRepoInit>
  engineCommand(vendor: VendorId | undefined): readonly string[]
}

const realPromptDeliveryOps: PromptDeliveryOps = {
  sessionExists,
  ensureSession: async (opts) => (await import("../tui/panes/terminal/tmux.ts")).ensureSession(opts),
  waitForEnginePane,
  pasteAndSubmit,
  resolveRepoInit: async (repoRoot, worktreePath) =>
    (await import("../state/repo-init.ts")).resolveRepoInit(repoRoot, worktreePath),
  engineCommand: interactiveEngineCommand,
}

async function deliverPrompt(
  client: DaemonRpc,
  target: PromptTarget,
  prompt: string,
  ops: PromptDeliveryOps = realPromptDeliveryOps,
): Promise<DeliveredPrompt> {
  let worktree = target.worktreePath
  if (!worktree) {
    const res = await client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: target.id })
    worktree = res.worktreePath
  }
  if (!worktree) throw new ApiError(`task ${target.id} has no worktree`, "NO_WORKTREE")

  const session = tmuxSessionName(target.id)
  const existed = await ops.sessionExists(session)
  if (!existed) {
    const init = await ops.resolveRepoInit(target.repo ?? "", worktree)
    const ok = await ops.ensureSession({
      name: session,
      cwd: worktree,
      command: ops.engineCommand(target.vendor),
      taskId: target.id,
      vendor: target.vendor,
      repo: target.repo,
      // The EXPLICIT prompt is what gets delivered below — never pass the
      // repo's initPrompt here, or a fresh session would get both pastes.
      initScript: init.initScript,
    })
    if (!ok) throw new ApiError(`failed to start tmux session for ${target.id}`, "SESSION_FAILED")
  }

  const { pane, ready } = await ops.waitForEnginePane(session, !existed)
  if (!pane) throw new ApiError(`no engine pane in session ${session}`, "NO_ENGINE_PANE")

  await ops.pasteAndSubmit(pane, prompt)
  return { session, pane, started: !existed, engineReady: ready }
}

async function resolveActiveTaskId(client: DaemonRpc): Promise<string | null> {
  let activeId: string | null = null
  const off = client.onChannel("active-task", (payload) => {
    activeId = payload.taskId
  })
  try {
    await client.subscribe()
  } finally {
    off()
  }
  return activeId
}

// ── Runtime (the side-effect seam handlers run against) ─────────────────────

/**
 * Everything a verb handler touches BESIDES the daemon RPC: tmux session
 * liveness, prompt delivery, git worktree reads. The default implementation
 * is the real thing (lazy-importing the heavier modules); unit tests swap
 * in fakes so handler logic runs without a daemon, tmux, or git.
 */
interface ApiRuntime {
  /** True iff the task's tmux session is live. */
  isTaskRunning(taskId: string): Promise<boolean>
  /** Deliver a prompt into a task's engine pane (building the session if needed). */
  deliverPrompt(client: DaemonRpc, target: PromptTarget, prompt: string): Promise<DeliveredPrompt>
  /** Canonical repo-root key for grouping tasks by repo. */
  resolveRepoRoot(absPath: string): Promise<string>
  /** Uncommitted +/− counts for a worktree. */
  readWorktreeChanges(worktreePath: string): Promise<{ added: number; deleted: number }>
  /**
   * Stop and kill a task's tmux session (and its engine), mirroring the TUI's
   * delete/archive teardown. The daemon must NOT touch tmux (it never imports
   * it), so the CLI process owns this teardown — run only AFTER the matching
   * `task.delete`/`task.archive` RPC succeeds. `switchClientBeforeKill` no-ops
   * outside tmux (the CLI is rarely attached); `killSession` no-ops when the
   * session isn't live. Best-effort: a teardown failure must not fail the
   * already-committed RPC, so it never throws.
   */
  tearDownSession(taskId: string): Promise<void>
}

const defaultApiRuntime: ApiRuntime = {
  isTaskRunning: (taskId) => sessionExists(tmuxSessionName(taskId)),
  deliverPrompt: (client, target, prompt) => deliverPrompt(client, target, prompt),
  resolveRepoRoot: async (absPath) => (await import("../state/repos.ts")).resolveRepoRoot(absPath),
  readWorktreeChanges: async (worktreePath) =>
    (await import("../tui/panes/sidebar/worktree-changes.ts")).readWorktreeChanges(worktreePath),
  tearDownSession: async (taskId) => {
    const session = tmuxSessionName(taskId)
    // Switch any attached client away first so a kill doesn't blank a terminal
    // (no-op when this process isn't on that session), then kill the session +
    // its engine. Both are swallowed — the task is already gone from the index.
    await switchClientBeforeKill(session).catch(() => {})
    await killSession(session).catch(() => {})
  },
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** The daemon RPC surface, or the canonical "daemon required" error for an offline call. */
function daemonOf(ctx: VerbContext): DaemonRpc {
  if (!ctx.client) throw new ApiError("daemon required", "BAD_DAEMON")
  return ctx.client
}

/** Fire one daemon RPC and return its raw payload (the generic CRUD shape). */
async function simpleRpc(ctx: VerbContext, name: string, payload: Record<string, unknown>): Promise<unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: the protocol's request name is a finite union; this is the one generic call site.
  return daemonOf(ctx).request(name as any, payload)
}

async function add(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args } = ctx
  const payload: Record<string, string> = { repo: args.requirePath("repo") }
  const title = args.str("title")
  if (title) payload.title = title
  const branch = args.str("branch")
  if (branch) payload.branch = branch
  const baseRef = args.str("base-branch")
  if (baseRef) payload.baseRef = baseRef
  const vendor = args.vendor()
  if (vendor) payload.vendor = vendor

  const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
  const taskId = res.taskId

  // status / pin aren't create-time fields on the RPC — apply them as
  // follow-ups so `add` is the one-stop "make me a task exactly like this".
  const status = args.enumOf<TaskStatus>("status")
  if (status) await daemon.request("task.status", { taskId, status })
  const pin = args.bool("pin")
  if (pin !== undefined) await daemon.request("task.pin", { taskId, pinned: pin })

  let task = res.task
  if (status || pin !== undefined) {
    task = (await daemon.request<{ task: SerializedTask }>("task.get", { taskId })).task
  }

  const prompt = args.str("prompt")
  if (!prompt) return { taskId, task, started: false }
  const delivered = await ctx.runtime.deliverPrompt(
    daemon,
    { id: taskId, worktreePath: task.worktreePath, vendor: task.vendor as VendorId | undefined, repo: task.repo },
    prompt,
  )
  return { taskId, task, started: delivered.started, engineReady: delivered.engineReady, session: delivered.session }
}

async function send(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const prompt = ctx.args.require("prompt")
  let taskId = ctx.args.str("task-id")
  if (!taskId) {
    const active = await resolveActiveTaskId(daemon)
    if (!active) {
      throw new ApiError(
        "no --task-id given and no active task — open a task first or pass --task-id",
        "MISSING_TARGET",
      )
    }
    taskId = active
  }
  const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
  const delivered = await ctx.runtime.deliverPrompt(
    daemon,
    {
      id: taskId,
      worktreePath: res.task.worktreePath,
      vendor: res.task.vendor as VendorId | undefined,
      repo: res.task.repo,
    },
    prompt,
  )
  return {
    ok: true,
    taskId,
    session: delivered.session,
    started: delivered.started,
    engineReady: delivered.engineReady,
  }
}

async function getTask(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
  const running = await ctx.runtime.isTaskRunning(taskId)
  return { task: res.task, running }
}

async function list(ctx: VerbContext): Promise<unknown> {
  return daemonOf(ctx).request<{ tasks: SerializedTask[] }>("task.list")
}

async function setActive(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const none = ctx.args.bool("none")
  const taskId = none ? null : ctx.args.require("task-id")
  await daemon.request("task.setActive", { taskId })
  return { ok: true, activeTaskId: taskId }
}

async function archive(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const archived = ctx.args.bool("archived") ?? true
  const res = await daemon.request("task.archive", { taskId, archived })
  // Archiving STOPS the engine (matching the TUI's archiveTaskFlow + the verb's
  // own "non-destructive: worktree/branch/history stay" contract): the data
  // survives, but the live tmux session + engine subprocess must not keep
  // burning resources. Unarchive is the inverse — it must NOT kill (the session
  // is rebuilt fresh on next enter), so teardown is gated on `archived === true`.
  // The daemon never touches tmux, so the kill runs here in the CLI process,
  // only after the RPC has committed the flag.
  if (archived) await ctx.runtime.tearDownSession(taskId)
  return res
}

async function deleteTask(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.require("task-id")
  const force = ctx.args.bool("force") ?? false
  const res = await daemon.request("task.delete", { taskId, force })
  // The daemon's task.delete removes the worktree + index entry but never the
  // tmux session (it doesn't import tmux). Without this, a scripted delete
  // orphans the `kobe-<id>` session + its engine — invisible to every kobe UI
  // since the task is gone from tasks.json. Mirror the TUI's finishDeletedTaskFlow
  // and kill it here, after the delete RPC succeeds.
  await ctx.runtime.tearDownSession(taskId)
  return res
}

async function adopt(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args } = ctx
  const input: Record<string, string> = {
    repo: args.requirePath("repo"),
    worktreePath: args.requirePath("worktree"),
  }
  const branch = args.str("branch")
  if (branch) input.branch = branch
  const vendor = args.vendor()
  if (vendor) input.vendor = vendor
  const title = args.str("title")
  if (title) input.title = title
  return daemon.request<{ task: SerializedTask }>("worktree.adopt", input)
}

async function fanOut(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args } = ctx
  const repo = args.requirePath("repo")
  const prompt = args.require("prompt")
  const title = args.str("title")
  const baseRef = args.str("base-branch")

  const agentsSpec = args.str("agents")
  const plan: VendorId[] = agentsSpec
    ? parseAgentsSpec(agentsSpec)
    : new Array<VendorId>(args.int("count") ?? 1).fill(args.vendor() ?? "claude")

  if (plan.length > FANOUT_CAP) {
    throw new ApiError(`fan-out of ${plan.length} exceeds the cap of ${FANOUT_CAP} — spawn in batches`, "BAD_FLAG")
  }

  const tasks: unknown[] = []
  for (const vendor of plan) {
    const payload: Record<string, string> = { repo, vendor }
    if (title) payload.title = title
    if (baseRef) payload.baseRef = baseRef
    const res = await daemon.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
    const delivered = await ctx.runtime.deliverPrompt(
      daemon,
      { id: res.taskId, worktreePath: res.task.worktreePath, vendor, repo: res.task.repo },
      prompt,
    )
    tasks.push({
      taskId: res.taskId,
      vendor,
      started: delivered.started,
      engineReady: delivered.engineReady,
      session: delivered.session,
    })
  }
  return { count: tasks.length, tasks }
}

async function collect(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const idsFlag = args.str("task-ids")
  const repoFlag = args.path("repo")

  let taskIds: string[]
  if (idsFlag) {
    taskIds = idsFlag
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (repoFlag) {
    const target = await runtime.resolveRepoRoot(repoFlag)
    const { tasks } = await daemon.request<{ tasks: SerializedTask[] }>("task.list")
    taskIds = []
    for (const t of tasks) {
      if (t.archived) continue
      if ((await runtime.resolveRepoRoot(t.repo)) === target) taskIds.push(t.id)
    }
  } else {
    throw new ApiError("collect needs --task-ids id1,id2 or --repo PATH", "MISSING_TARGET")
  }

  const out: unknown[] = []
  for (const taskId of taskIds) {
    const { task } = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
    const running = await runtime.isTaskRunning(taskId)
    const changes = task.worktreePath ? await runtime.readWorktreeChanges(task.worktreePath) : { added: 0, deleted: 0 }
    out.push({
      taskId: task.id,
      title: task.title,
      branch: task.branch,
      worktreePath: task.worktreePath,
      vendor: task.vendor,
      status: task.status,
      running,
      changes,
    })
  }
  return { tasks: out }
}

async function feedback(ctx: VerbContext): Promise<unknown> {
  const result = submitFeedback({
    title: ctx.args.require("title"),
    body: ctx.args.require("body"),
    categorySlug: ctx.args.str("category"),
  })
  return { ok: true, discussion: result }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

function makeContext(verb: VerbSpec, flags: Flags, client: DaemonRpc | null, runtime: ApiRuntime): VerbContext {
  return { args: new VerbArgs(verb, flags), client, runtime }
}

/**
 * Parse + validate + run ONE verb against an injected client/runtime —
 * the unit-test (and embedding) entry. Throws {@link ApiError} instead of
 * exiting; `runApiSubcommand` keeps the process-exit/JSON-emit wrapper.
 */
export async function invokeVerb(
  verbName: string,
  argv: readonly string[],
  deps: { client: DaemonRpc | null; runtime?: ApiRuntime },
): Promise<unknown> {
  const verb = findVerb(verbName)
  if (!verb) throw new ApiError(`unknown verb: ${verbName}`, "BAD_VERB")
  const booleanFlags = new Set(verb.flags.filter((f) => f.type === "bool").map((f) => f.name))
  const parsed = parseFlags(argv, booleanFlags)
  validateAgainstSpec(verb, parsed.flags)
  return verb.handler(makeContext(verb, parsed.flags, deps.client, deps.runtime ?? defaultApiRuntime))
}

export async function runApiSubcommand(argv: readonly string[]): Promise<void> {
  const [verbName, ...rest] = argv
  if (!verbName || verbName === "--help" || verbName === "-h" || verbName === "help") {
    if (!verbName) fail(apiUsage(), "MISSING_VERB", 2)
    process.stdout.write(`${apiUsage()}\n`)
    return
  }
  const verb = findVerb(verbName)
  if (!verb) fail(`unknown verb: ${verbName}\n${apiUsage()}`, "BAD_VERB", 2)

  const booleanFlags = new Set(verb.flags.filter((f) => f.type === "bool").map((f) => f.name))
  let parsed: ParsedArgs
  try {
    parsed = parseFlags(rest, booleanFlags)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 2)
    fail(err instanceof Error ? err.message : String(err), "BAD_FLAG", 2)
  }

  if (parsed.help) {
    process.stdout.write(`${verbHelp(verb)}\n`)
    return
  }

  try {
    validateAgainstSpec(verb, parsed.flags)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 2)
    fail(err instanceof Error ? err.message : String(err), "BAD_FLAG", 2)
  }

  let session: DaemonSession | null = null
  if (!verb.offline) {
    try {
      session = await openDaemonSession()
    } catch (err) {
      fail(
        `could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}`,
        "BAD_DAEMON",
        2,
      )
    }
  }

  try {
    const result = await verb.handler(makeContext(verb, parsed.flags, session?.client ?? null, defaultApiRuntime))
    emit(result, parsed.pretty)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 1)
    fail(err instanceof Error ? err.message : String(err), "RPC_ERROR", 1)
  } finally {
    session?.close()
  }
}

// Exported for tests.
export {
  ApiError,
  VERBS,
  VERB_GROUPS,
  VerbArgs,
  deliverPrompt,
  defaultApiRuntime,
  findVerb,
  validateAgainstSpec,
  schemaIndex,
  verbSchema,
  fullSchema,
}
export type { VerbSpec, FlagSpec, VerbContext, ApiRuntime, PromptDeliveryOps, PromptTarget, DeliveredPrompt }
