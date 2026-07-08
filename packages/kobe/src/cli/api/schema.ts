/**
 * Schema + `--help` rendering — everything derived from the {@link VERBS}
 * table. Split out of `api-cmd.ts` (see that file's header). The `schema`
 * verb's HANDLER (`handleSchema`) lives in `verbs.ts` instead of here: it's
 * referenced inside the `VERBS` array literal, which is evaluated at
 * module-load time, so a handler defined in a module that imports `VERBS`
 * back from `verbs.ts` would be `undefined` at that point (load-order
 * circular-import hazard). The render functions below have no such
 * constraint — they're only called from inside other function bodies.
 */

import { CURRENT_VERSION } from "../../version.ts"
import { ApiError, type FlagSpec, type VerbSpec } from "./types.ts"
import { VERBS, VERB_ALIASES, VERB_GROUPS, findVerb } from "./verbs.ts"

/** Bumped when the verb/flag shape changes incompatibly. Agents can gate on it. */
export const API_SCHEMA_VERSION = 2

export function groupOf(verbName: string): string {
  for (const [group, names] of Object.entries(VERB_GROUPS)) {
    if (names.includes(verbName)) return group
  }
  return "other"
}

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
export function verbSchema(v: VerbSpec): unknown {
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
export function schemaIndex(): unknown {
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
export function groupSchema(group: string): unknown {
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
export function fullSchema(): unknown {
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
