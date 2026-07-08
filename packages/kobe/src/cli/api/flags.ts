/**
 * Flag parsing, spec-driven validation, and the spec-typed accessor
 * (`VerbArgs`) handlers read flags through. Split out of `api-cmd.ts` (see
 * that file's header) — this module is the "how a verb reads its own
 * flags" half of the contract; `types.ts` owns the shapes, `verbs.ts` owns
 * the table of specs.
 */

import { resolve } from "node:path"
import { expandTilde } from "../../lib/path-home.ts"
import { ALL_VENDORS, type VendorId } from "../../types/vendor.ts"
import { ApiError, type FlagSpec, type Flags, type ParsedArgs, type VerbSpec } from "./types.ts"

/** Safety cap on a single fan-out so a typo can't spawn a runaway fleet. */
export const FANOUT_CAP = 10

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
    // Reject against the fanout cap BEFORE materializing the array — otherwise
    // `--agents claude:1000000000` allocates a billion-element array (OOM) only
    // to be rejected by the post-build `plan.length > FANOUT_CAP` check.
    if (out.length + count > FANOUT_CAP) {
      throw new ApiError(`--agents requests ${out.length + count} agents, exceeds the cap of ${FANOUT_CAP}`, "BAD_FLAG")
    }
    for (let i = 0; i < count; i++) out.push(vendor as VendorId)
  }
  if (out.length === 0) throw new ApiError('--agents specified no agents (e.g. "claude:2,codex:1")', "BAD_FLAG")
  return out
}

/**
 * Build the fan-out plan for the `--count` form (`--count N`, all one vendor):
 * N copies of `vendor`. Rejects against the fanout cap BEFORE allocating —
 * symmetric to {@link parseAgentsSpec}, so `--count 1000000000` fails fast
 * instead of materializing a billion-element array (OOM) only to be caught by
 * the post-build `plan.length > FANOUT_CAP` check.
 */
export function buildCountPlan(count: number, vendor: VendorId): VendorId[] {
  if (count > FANOUT_CAP) {
    throw new ApiError(`fan-out of ${count} exceeds the cap of ${FANOUT_CAP} — spawn in batches`, "BAD_FLAG")
  }
  return new Array<VendorId>(count).fill(vendor)
}
