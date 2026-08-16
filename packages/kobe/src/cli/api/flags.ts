/**
 * Flag parsing, spec-driven validation, and the spec-typed accessor
 * (`VerbArgs`) handlers read flags through. Split out of `api-cmd.ts` (see
 * that file's header) — this module is the "how a verb reads its own
 * flags" half of the contract; `types.ts` owns the shapes, `verbs.ts` owns
 * the table of specs.
 */

import { resolve } from "node:path"
import { expandTilde } from "../../lib/path-home.ts"
import { getCustomEngineIds } from "../../state/repos.ts"
import { ALL_VENDORS, type VendorId } from "../../types/vendor.ts"
import { ApiError, type FlagSpec, type Flags, type ParsedArgs, type VerbSpec, helpStep } from "./types.ts"

/** Safety cap on a single `add --count` round so a typo can't spawn a runaway fleet. */
export const FANOUT_CAP = 10

/** Both parallel-plan parsers are only reachable from `add`, so their errors point at its help. */
const FANOUT_STEP = helpStep("add")

/** Reusable flag fragments shared across the verb tables (`verbs.ts`, `verbs-issues.ts`). */
export const F = {
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
  /**
   * The dispatch face's single engine flag: a RAW launch command. Either a
   * registered engine id (`engine-list`, whose `engineCommand.<id>` override
   * applies) or a full command line kobe runs verbatim. The protocol kobe
   * speaks is derived from it, so there is nothing else to declare — and no
   * validation layer: an unfamiliar engine's flags are the caller's job to
   * probe (`<cmd> --help`) before dispatching.
   */
  command: (): FlagSpec => ({
    name: "command",
    type: "string",
    placeholder: "CMD",
    description:
      "Engine launch command, verbatim — an engine id from `engine-list` (e.g. claude) or a full command line (e.g. 'codex --search'). Unvalidated: probe an unfamiliar engine's flags with `<cmd> --help` first. Omitted = the repo's default engine.",
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
export function validateAgainstSpec(verb: VerbSpec, flags: Flags): void {
  const known = new Set(verb.flags.map((f) => f.name))
  for (const key of flags.keys()) {
    if (!known.has(key)) {
      throw new ApiError(`unknown flag --${key} for "${verb.name}"`, "BAD_FLAG", helpStep(verb.name))
    }
  }
  for (const f of verb.flags) {
    if (f.required && !flags.get(f.name))
      throw new ApiError(`--${f.name} is required for "${verb.name}"`, "MISSING_FLAG", helpStep(verb.name))
    if (f.type === "enum" && f.values) {
      const raw = flags.get(f.name)
      if (raw !== undefined && !f.values.includes(raw)) {
        // `--vendor` is the one OPEN enum: its `values` lists the built-ins
        // for `--help`, but a user-registered custom engine id is equally
        // valid (the daemon accepts any non-empty string — `optionalVendor`).
        // Without this the spec gate rejected every custom engine before a
        // handler could ever see it, while the TUI happily offered them.
        if (f.name === "vendor" && getCustomEngineIds().includes(raw)) continue
        throw new ApiError(`--${f.name} must be one of ${f.values.join(", ")}`, "BAD_FLAG", helpStep(verb.name))
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
export class VerbArgs {
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
      throw new ApiError(`--${name} must be one of ${f.values.join(", ")}`, "BAD_FLAG", helpStep(this.verb.name))
    }
    return v as T
  }

  /** Required enum value. */
  requireEnum<T extends string>(name: string): T {
    this.require(name)
    return this.enumOf<T>(name) as T
  }

  /**
   * The shared `--vendor` flag, typed.
   *
   * NOT `enumOf`: engines are an OPEN set. The spec's `values` lists the
   * built-ins (that's what `--help` should show), but a user-registered
   * custom engine — a slug in `customEngineIds`, its launch command in
   * `engineCommand.<id>` — is equally valid, and the daemon already accepts
   * any non-empty string for exactly this reason (`optionalVendor`). Reading
   * the static list here made every custom engine unsettable through the
   * CLI while the TUI selector offered it.
   */
  vendor(): VendorId | undefined {
    const value = this.str("vendor")
    if (value === undefined) return undefined
    const builtins = this.spec("vendor").values ?? ALL_VENDORS
    if (builtins.includes(value)) return value as VendorId
    // Registry read is lazy — only a non-built-in id pays for the state read.
    if (getCustomEngineIds().includes(value)) return value as VendorId
    throw new ApiError(
      `--vendor must be a built-in (${builtins.join(", ")}) or a registered custom engine id`,
      "BAD_FLAG",
      helpStep(this.verb.name),
    )
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

  /** Optional PATH flag resolved against $PWD (with a leading `~` expanded first). */
  path(name: string): string | undefined {
    const v = this.str(name)
    return v === undefined ? undefined : resolve(process.cwd(), expandTilde(v))
  }

  /** Required PATH flag resolved against $PWD (with a leading `~` expanded first). */
  requirePath(name: string): string {
    return resolve(process.cwd(), expandTilde(this.require(name)))
  }
}

/**
 * Parse a multi-engine spec like `claude:2,codex:1` into a flat list with
 * one PRESET ID per task to spawn (`[claude, claude, codex]`).
 *
 * Preset ids, not raw commands: an id is a slug, so it survives the
 * `,`/`:` separators a full command line would collide with. Registered
 * custom presets count — a named preset IS an engine here, the same way it
 * is everywhere else. Mixing raw command lines in one call is not
 * expressible; issue N `add --command …` calls instead.
 */
export function parseAgentsSpec(spec: string): VendorId[] {
  const out: VendorId[] = []
  for (const part of spec.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) throw new ApiError(`--agents entry "${trimmed}" must be engine:count`, "BAD_FLAG", FANOUT_STEP)
    const vendor = trimmed.slice(0, colon)
    if (!ALL_VENDORS.includes(vendor as VendorId) && !getCustomEngineIds().includes(vendor)) {
      throw new ApiError(
        `--agents engine "${vendor}" must be a built-in (${ALL_VENDORS.join(", ")}) or a registered engine id — see \`engine-list\``,
        "BAD_FLAG",
        FANOUT_STEP,
      )
    }
    const count = Number.parseInt(trimmed.slice(colon + 1), 10)
    if (!Number.isInteger(count) || count <= 0) {
      throw new ApiError(`--agents count for "${vendor}" must be a positive integer`, "BAD_FLAG", FANOUT_STEP)
    }
    // Reject against the fanout cap BEFORE materializing the array — otherwise
    // `--agents claude:1000000000` allocates a billion-element array (OOM) only
    // to be rejected by the post-build `plan.length > FANOUT_CAP` check.
    if (out.length + count > FANOUT_CAP) {
      throw new ApiError(
        `--agents requests ${out.length + count} agents, exceeds the cap of ${FANOUT_CAP}`,
        "BAD_FLAG",
        FANOUT_STEP,
      )
    }
    for (let i = 0; i < count; i++) out.push(vendor as VendorId)
  }
  if (out.length === 0)
    throw new ApiError('--agents specified no agents (e.g. "claude:2,codex:1")', "BAD_FLAG", FANOUT_STEP)
  return out
}

/**
 * Build the parallel plan for the `--count` form (`--count N`, all one
 * engine): N copies of `vendor`. Rejects against the cap BEFORE allocating —
 * symmetric to {@link parseAgentsSpec}, so `--count 1000000000` fails fast
 * instead of materializing a billion-element array (OOM) only to be caught by
 * the post-build `plan.length > FANOUT_CAP` check.
 */
export function buildCountPlan(count: number, vendor: VendorId): VendorId[] {
  if (count > FANOUT_CAP) {
    throw new ApiError(
      `--count ${count} exceeds the parallel cap of ${FANOUT_CAP} — spawn in batches`,
      "BAD_FLAG",
      FANOUT_STEP,
    )
  }
  return new Array<VendorId>(count).fill(vendor)
}
