#!/usr/bin/env bun
// One-shot extractor: walk refs/claude-code/src/commands/ for visible
// commands and emit a TS module kobe can ship with.
//
// kobe runs `claude -p <prompt>` (non-interactive print mode), so we
// also pull each command's `type` plus `supportsNonInteractive`
// (LocalCommand) / `disableNonInteractive` (PromptCommand) and filter
// out commands that won't work in -p mode. Without the filter, the
// composer's slash menu surfaces e.g. `/help` (LocalJSXCommand) and the
// user submits it just to see "/help isn't available in this
// environment" come back from claude. Match claude's runtime gate
// rather than re-discover it via error messages.
//
// Filter rules (mirror refs/claude-code/src/types/command.ts):
//   - `local-jsx`              → always exclude (renders React, no -p path)
//   - `local`                  → include only when supportsNonInteractive=true
//   - `prompt` (default)       → include unless disableNonInteractive=true
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[2] ?? "refs/claude-code/src/commands")

function pullStringField(src, field) {
  const m = src.match(new RegExp(`${field}:\\s*'([^']+)'`)) ?? src.match(new RegExp(`${field}:\\s*"([^"]+)"`))
  return m?.[1]
}
function pullBoolField(src, field) {
  const m = src.match(new RegExp(`${field}:\\s*(true|false)`))
  if (!m) return undefined
  return m[1] === "true"
}
function pullAliases(src) {
  const m = src.match(/aliases:\s*\[([^\]]*)\]/)
  if (!m) return []
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((mm) => mm[1])
}
function isHidden(src) {
  return /isHidden:\s*true/.test(src)
}

const out = []
let droppedJsx = 0
let droppedNonInteractive = 0
for (const entry of readdirSync(ROOT)) {
  const full = join(ROOT, entry)
  let file
  try {
    if (existsSync(join(full, "index.ts"))) file = join(full, "index.ts")
    else if (existsSync(join(full, "index.tsx"))) file = join(full, "index.tsx")
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) file = full
    else continue
  } catch {
    continue
  }
  let src
  try {
    src = readFileSync(file, "utf8")
  } catch {
    continue
  }
  const name = pullStringField(src, "name")
  if (!name) continue
  if (isHidden(src)) continue

  const type = pullStringField(src, "type")
  if (type === "local-jsx") {
    droppedJsx++
    continue
  }
  if (type === "local") {
    const supportsNI = pullBoolField(src, "supportsNonInteractive")
    if (supportsNI !== true) {
      droppedNonInteractive++
      continue
    }
  }
  if (type === "prompt") {
    const disableNI = pullBoolField(src, "disableNonInteractive")
    if (disableNI === true) {
      droppedNonInteractive++
      continue
    }
  }

  const description = pullStringField(src, "description") ?? ""
  const aliases = pullAliases(src)
  out.push({ name, description, aliases })
}

out.sort((a, b) => a.name.localeCompare(b.name))

const lines = []
lines.push("// AUTO-GENERATED from refs/claude-code/src/commands/ — see")
lines.push("// scripts/extract-claude-code-commands.mjs. Do not hand-edit; rerun the")
lines.push("// extractor when you sync the refs/ snapshot.")
lines.push("//")
lines.push("// Filtered to commands that work in `claude -p` (non-interactive)")
lines.push(`// mode: dropped ${droppedJsx} local-jsx + ${droppedNonInteractive} non-interactive-disabled.`)
lines.push("export type BuiltinSlash = {")
lines.push("  readonly name: string")
lines.push("  readonly description: string")
lines.push("  readonly aliases?: readonly string[]")
lines.push("}")
lines.push("")
lines.push("export const BUILTIN_CLAUDE_SLASHES: readonly BuiltinSlash[] = [")
for (const cmd of out) {
  const desc = cmd.description.replace(/`/g, "\\`")
  const aliases = cmd.aliases.length > 0 ? `, aliases: [${cmd.aliases.map((a) => JSON.stringify(a)).join(", ")}]` : ""
  lines.push(`  { name: ${JSON.stringify(cmd.name)}, description: ${JSON.stringify(desc)}${aliases} },`)
}
lines.push("] as const")
lines.push("")

process.stdout.write(lines.join("\n"))
