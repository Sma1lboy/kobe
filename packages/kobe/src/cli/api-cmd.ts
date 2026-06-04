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
 * The verb table {@link VERBS} is the single source of truth: it drives the
 * `schema` verb (machine-readable JSON of every verb + flag), per-verb
 * `--help`, and flag validation (required / enum / unknown-flag rejection).
 * An agent runs `kobe api schema` once and knows the whole API — names,
 * types, which flags are required, allowed enum values — without parsing
 * prose. Add a verb to {@link VERBS} and its help, schema entry, and
 * validation all come for free.
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
import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { sessionExists, tmuxSessionName } from "../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../tmux/prompt-delivery.ts"
import type { TaskStatus } from "../types/task.ts"
import { ALL_VENDORS, type VendorId } from "../types/vendor.ts"
import { CURRENT_VERSION } from "../version.ts"

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

interface VerbSpec {
  readonly name: string
  readonly summary: string
  readonly flags: readonly FlagSpec[]
  /** Verbs that don't need the daemon (e.g. `schema`). */
  readonly offline?: boolean
  readonly handler: (client: KobeDaemonClient | null, parsed: ParsedArgs) => Promise<unknown>
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
async function handleSchema(_client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  const { flags } = parsed
  const verbName = optional(flags, "verb")
  if (verbName) {
    const v = findVerb(verbName)
    if (!v) throw new ApiError(`unknown verb: ${verbName}`, "BAD_VERB")
    return verbSchema(v)
  }
  const group = optional(flags, "group")
  if (group) return groupSchema(group)
  if (optionalBool(flags, "all")) return fullSchema()
  return schemaIndex()
}

// VERBS — ordered for help readability: discovery, reads, create, drive, edit,
// lifecycle, worktree. Every entry's flags feed schema + --help + validation.
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
    handler: (c, p) =>
      simpleRpc(c, "task.rename", { taskId: required(p.flags, "task-id"), title: required(p.flags, "title") }),
  },
  {
    name: "set-branch",
    summary: "Rename a task's branch (git branch -m if materialized, else recorded).",
    flags: [
      F.taskId(),
      { name: "branch", type: "string", required: true, placeholder: "B", description: "New branch name." },
    ],
    handler: (c, p) =>
      simpleRpc(c, "task.setBranch", { taskId: required(p.flags, "task-id"), branch: required(p.flags, "branch") }),
  },
  {
    name: "set-vendor",
    summary: "Change a task's engine vendor (takes effect on next session rebuild).",
    flags: [F.taskId(), { ...F.vendor(), required: true }],
    handler: (c, p) =>
      simpleRpc(c, "task.setVendor", {
        taskId: required(p.flags, "task-id"),
        vendor: requireEnum(p.flags, "vendor", ALL_VENDORS),
      }),
  },
  {
    name: "set-status",
    summary: "Set a task's lifecycle status.",
    flags: [
      F.taskId(),
      { name: "status", type: "enum", required: true, values: TASK_STATUSES, description: "New status." },
    ],
    handler: (c, p) =>
      simpleRpc(c, "task.status", {
        taskId: required(p.flags, "task-id"),
        status: requireEnum(p.flags, "status", TASK_STATUSES),
      }),
  },
  {
    name: "archive",
    summary: "Archive (or with --archived=false, unarchive) a task. Non-destructive: worktree/branch/history stay.",
    flags: [
      F.taskId(),
      { name: "archived", type: "bool", default: "true", description: "true to archive, false to unarchive." },
    ],
    handler: (c, p) =>
      simpleRpc(c, "task.archive", {
        taskId: required(p.flags, "task-id"),
        archived: optionalBool(p.flags, "archived") ?? true,
      }),
  },
  {
    name: "pin",
    summary: "Pin (or with --pinned=false, unpin) a task to the top of the sidebar.",
    flags: [F.taskId(), { name: "pinned", type: "bool", default: "true", description: "true to pin, false to unpin." }],
    handler: (c, p) =>
      simpleRpc(c, "task.pin", {
        taskId: required(p.flags, "task-id"),
        pinned: optionalBool(p.flags, "pinned") ?? true,
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
    handler: (c, p) => simpleRpc(c, "task.ensureWorktree", { taskId: required(p.flags, "task-id") }),
  },
  {
    name: "delete",
    summary:
      "Permanently remove a task (and its worktree). DESTRUCTIVE — prefer `archive`. Needs --force on a dirty worktree.",
    flags: [F.taskId(), { name: "force", type: "bool", description: "Delete even with uncommitted changes." }],
    handler: (c, p) =>
      simpleRpc(c, "task.delete", {
        taskId: required(p.flags, "task-id"),
        force: optionalBool(p.flags, "force") ?? false,
      }),
  },
  {
    name: "discover-adoptable",
    summary: "List existing git worktrees in a repo not yet tracked as kobe tasks. Returns { worktrees }.",
    flags: [F.repo()],
    handler: (c, p) => simpleRpc(c, "worktree.discoverAdoptable", { repo: resolveRepoFlag(required(p.flags, "repo")) }),
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

function required(flags: Flags, key: string): string {
  const v = flags.get(key)
  if (v === undefined || v.length === 0) throw new ApiError(`--${key} is required`, "MISSING_FLAG")
  return v
}

function optional(flags: Flags, key: string): string | undefined {
  const v = flags.get(key)
  return v && v.length > 0 ? v : undefined
}

function requireEnum<T extends string>(flags: Flags, key: string, values: readonly T[]): T {
  const v = required(flags, key)
  if (!values.includes(v as T)) throw new ApiError(`--${key} must be one of ${values.join(", ")}`, "BAD_FLAG")
  return v as T
}

function optionalVendor(flags: Flags): VendorId | undefined {
  const raw = optional(flags, "vendor")
  if (raw === undefined) return undefined
  if (!ALL_VENDORS.includes(raw as VendorId)) {
    throw new ApiError(`--vendor must be one of ${ALL_VENDORS.join(", ")}`, "BAD_FLAG")
  }
  return raw as VendorId
}

function optionalBool(flags: Flags, key: string): boolean | undefined {
  const raw = optional(flags, key)
  if (raw === undefined) return undefined
  if (["true", "1", "yes"].includes(raw)) return true
  if (["false", "0", "no"].includes(raw)) return false
  throw new ApiError(`--${key} must be a boolean (true/false)`, "BAD_FLAG")
}

function optionalPositiveInt(flags: Flags, key: string): number | undefined {
  const raw = optional(flags, key)
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(`--${key} must be a positive integer`, "BAD_FLAG")
  return n
}

function resolveRepoFlag(repo: string): string {
  return resolve(process.cwd(), repo)
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

async function deliverPrompt(
  client: KobeDaemonClient,
  target: PromptTarget,
  prompt: string,
): Promise<{ session: string; pane: string; started: boolean; engineReady: boolean }> {
  let worktree = target.worktreePath
  if (!worktree) {
    const res = await client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: target.id })
    worktree = res.worktreePath
  }
  if (!worktree) throw new ApiError(`task ${target.id} has no worktree`, "NO_WORKTREE")

  const session = tmuxSessionName(target.id)
  const existed = await sessionExists(session)
  if (!existed) {
    const { ensureSession } = await import("../tui/panes/terminal/tmux.ts")
    const { resolveRepoInit } = await import("../state/repo-init.ts")
    const init = resolveRepoInit(target.repo ?? "", worktree)
    const ok = await ensureSession({
      name: session,
      cwd: worktree,
      command: interactiveEngineCommand(target.vendor),
      taskId: target.id,
      vendor: target.vendor,
      initScript: init.initScript,
    })
    if (!ok) throw new ApiError(`failed to start tmux session for ${target.id}`, "SESSION_FAILED")
  }

  const { pane, ready } = await waitForEnginePane(session, !existed)
  if (!pane) throw new ApiError(`no engine pane in session ${session}`, "NO_ENGINE_PANE")

  await pasteAndSubmit(pane, prompt)
  return { session, pane, started: !existed, engineReady: ready }
}

async function resolveActiveTaskId(client: KobeDaemonClient): Promise<string | null> {
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

// ── Handlers ─────────────────────────────────────────────────────────────────

/** Fire one daemon RPC and return its raw payload (the generic CRUD shape). */
async function simpleRpc(
  client: KobeDaemonClient | null,
  name: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  // biome-ignore lint/suspicious/noExplicitAny: the protocol's request name is a finite union; this is the one generic call site.
  return client.request(name as any, payload)
}

async function add(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const { flags } = parsed
  const payload: Record<string, string> = { repo: resolveRepoFlag(required(flags, "repo")) }
  const title = optional(flags, "title")
  if (title) payload.title = title
  const branch = optional(flags, "branch")
  if (branch) payload.branch = branch
  const baseRef = optional(flags, "base-branch")
  if (baseRef) payload.baseRef = baseRef
  const vendor = optionalVendor(flags)
  if (vendor) payload.vendor = vendor

  const res = await client.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
  const taskId = res.taskId

  // status / pin aren't create-time fields on the RPC — apply them as
  // follow-ups so `add` is the one-stop "make me a task exactly like this".
  const status = optional(flags, "status")
  if (status) await client.request("task.status", { taskId, status: requireEnum(flags, "status", TASK_STATUSES) })
  const pin = optionalBool(flags, "pin")
  if (pin !== undefined) await client.request("task.pin", { taskId, pinned: pin })

  let task = res.task
  if (status || pin !== undefined) {
    task = (await client.request<{ task: SerializedTask }>("task.get", { taskId })).task
  }

  const prompt = optional(flags, "prompt")
  if (!prompt) return { taskId, task, started: false }
  const delivered = await deliverPrompt(
    client,
    { id: taskId, worktreePath: task.worktreePath, vendor: task.vendor as VendorId | undefined, repo: task.repo },
    prompt,
  )
  return { taskId, task, started: delivered.started, engineReady: delivered.engineReady, session: delivered.session }
}

async function send(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const { flags } = parsed
  const prompt = required(flags, "prompt")
  let taskId = optional(flags, "task-id")
  if (!taskId) {
    const active = await resolveActiveTaskId(client)
    if (!active) {
      throw new ApiError(
        "no --task-id given and no active task — open a task first or pass --task-id",
        "MISSING_TARGET",
      )
    }
    taskId = active
  }
  const res = await client.request<{ task: SerializedTask }>("task.get", { taskId })
  const delivered = await deliverPrompt(
    client,
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

async function getTask(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const taskId = required(parsed.flags, "task-id")
  const res = await client.request<{ task: SerializedTask }>("task.get", { taskId })
  const running = await sessionExists(tmuxSessionName(taskId))
  return { task: res.task, running }
}

async function list(client: KobeDaemonClient | null): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  return client.request<{ tasks: SerializedTask[] }>("task.list")
}

async function setActive(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const none = optionalBool(parsed.flags, "none")
  const taskId = none ? null : required(parsed.flags, "task-id")
  await client.request("task.setActive", { taskId })
  return { ok: true, activeTaskId: taskId }
}

async function adopt(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const { flags } = parsed
  const input: Record<string, string> = {
    repo: resolveRepoFlag(required(flags, "repo")),
    worktreePath: resolveRepoFlag(required(flags, "worktree")),
  }
  const branch = optional(flags, "branch")
  if (branch) input.branch = branch
  const vendor = optionalVendor(flags)
  if (vendor) input.vendor = vendor
  const title = optional(flags, "title")
  if (title) input.title = title
  return client.request<{ task: SerializedTask }>("worktree.adopt", input)
}

async function fanOut(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const { flags } = parsed
  const repo = resolveRepoFlag(required(flags, "repo"))
  const prompt = required(flags, "prompt")
  const title = optional(flags, "title")
  const baseRef = optional(flags, "base-branch")

  const agentsSpec = optional(flags, "agents")
  const plan: VendorId[] = agentsSpec
    ? parseAgentsSpec(agentsSpec)
    : new Array<VendorId>(optionalPositiveInt(flags, "count") ?? 1).fill(optionalVendor(flags) ?? "claude")

  if (plan.length > FANOUT_CAP) {
    throw new ApiError(`fan-out of ${plan.length} exceeds the cap of ${FANOUT_CAP} — spawn in batches`, "BAD_FLAG")
  }

  const tasks: unknown[] = []
  for (const vendor of plan) {
    const payload: Record<string, string> = { repo, vendor }
    if (title) payload.title = title
    if (baseRef) payload.baseRef = baseRef
    const res = await client.request<{ taskId: string; task: SerializedTask }>("task.create", payload)
    const delivered = await deliverPrompt(
      client,
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

async function collect(client: KobeDaemonClient | null, parsed: ParsedArgs): Promise<unknown> {
  if (!client) throw new ApiError("daemon required", "BAD_DAEMON")
  const { flags } = parsed
  const idsFlag = optional(flags, "task-ids")
  const repoFlag = optional(flags, "repo")

  let taskIds: string[]
  if (idsFlag) {
    taskIds = idsFlag
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (repoFlag) {
    const { resolveRepoRoot } = await import("../state/repos.ts")
    const target = resolveRepoRoot(resolveRepoFlag(repoFlag))
    const { tasks } = await client.request<{ tasks: SerializedTask[] }>("task.list")
    taskIds = tasks.filter((t) => !t.archived && resolveRepoRoot(t.repo) === target).map((t) => t.id)
  } else {
    throw new ApiError("collect needs --task-ids id1,id2 or --repo PATH", "MISSING_TARGET")
  }

  const { readWorktreeChanges } = await import("../tui/panes/sidebar/worktree-changes.ts")
  const out: unknown[] = []
  for (const taskId of taskIds) {
    const { task } = await client.request<{ task: SerializedTask }>("task.get", { taskId })
    const running = await sessionExists(tmuxSessionName(taskId))
    const changes = task.worktreePath ? readWorktreeChanges(task.worktreePath) : { added: 0, deleted: 0 }
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

// ── Dispatch ─────────────────────────────────────────────────────────────────

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

  let client: KobeDaemonClient | null = null
  if (!verb.offline) {
    try {
      client = await connectOrStartDaemon()
    } catch (err) {
      fail(
        `could not reach or start the kobe daemon: ${err instanceof Error ? err.message : String(err)}`,
        "BAD_DAEMON",
        2,
      )
    }
  }

  try {
    const result = await verb.handler(client, parsed)
    emit(result, parsed.pretty)
  } catch (err) {
    if (err instanceof ApiError) fail(err.message, err.code, 1)
    fail(err instanceof Error ? err.message : String(err), "RPC_ERROR", 1)
  } finally {
    client?.close()
  }
}

// Exported for tests.
export { ApiError, VERBS, VERB_GROUPS, findVerb, validateAgainstSpec, schemaIndex, verbSchema, fullSchema }
export type { VerbSpec, FlagSpec }
