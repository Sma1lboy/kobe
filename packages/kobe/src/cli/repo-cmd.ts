/**
 * `kobe repo <show|set|unset> [path]` — manage a repo's per-user init
 * override (the `initScript` / `initPrompt` stored in state.json).
 *
 * This override is the FALLBACK default for a repo that doesn't ship its
 * own `.kobe/init.sh` / `.kobe/init-prompt.md`; the in-repo files win when
 * present (see `state/repo-init.ts`). The path defaults to the current
 * directory and is normalized to its git toplevel, so every worktree of
 * the repo resolves the same entry.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_USAGE = [
  "Usage: kobe repo <show|set|unset> [path] [options]",
  "",
  "Manage a repo's per-user init override (state.json fallback for repos",
  "that don't ship .kobe/init.sh / .kobe/init-prompt.md).",
  "",
  "Commands:",
  "  show [path]                 Print the override + whether the repo ships .kobe/ files",
  "  set [path] <options>        Set the init script and/or first prompt",
  "  unset [path] [--init-script] [--init-prompt]   Clear one or both (default: both)",
  "",
  "Set options (later wins; *-file reads from disk):",
  "  --init-script <text>        Inline shell to run before the engine",
  "  --init-script-file <path>   Read the init script from a file",
  "  --init-prompt <text>        Inline first prompt for the engine",
  "  --init-prompt-file <path>   Read the first prompt from a file",
  "",
  "  path defaults to the current directory (resolved to its git toplevel).",
  "",
].join("\n")

function usageError(message: string): never {
  process.stderr.write(`kobe repo: ${message}\n\n${REPO_USAGE}\n`)
  process.exit(2)
}

function readArgFile(path: string): string {
  try {
    return readFileSync(resolve(process.cwd(), path), "utf8")
  } catch (err) {
    usageError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Pull `--flag value` / `--flag-file path` out of `set` argv, leaving the path positional. */
interface RepoFlags {
  path?: string
  initScript?: string
  initPrompt?: string
}

function parseRepoArgs(args: readonly string[]): RepoFlags {
  const out: RepoFlags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const need = (): string => {
      const v = args[++i]
      if (v === undefined) usageError(`${a} requires a value`)
      return v
    }
    if (a === "--init-script") out.initScript = need()
    else if (a === "--init-script-file") out.initScript = readArgFile(need())
    else if (a === "--init-prompt") out.initPrompt = need()
    else if (a === "--init-prompt-file") out.initPrompt = readArgFile(need())
    else if (a.startsWith("-")) usageError(`unknown flag "${a}"`)
    else if (out.path === undefined) out.path = a
    else usageError(`unexpected argument "${a}"`)
  }
  return out
}

/** unset has its own flag meaning (boolean clears), so parse it separately. */
function parseUnsetArgs(args: readonly string[]): { path?: string; clearScript: boolean; clearPrompt: boolean } {
  let path: string | undefined
  let clearScript = false
  let clearPrompt = false
  for (const a of args) {
    if (a === "--init-script") clearScript = true
    else if (a === "--init-prompt") clearPrompt = true
    else if (a.startsWith("-")) usageError(`unknown flag "${a}"`)
    else if (path === undefined) path = a
    else usageError(`unexpected argument "${a}"`)
  }
  // No field flag → clear both.
  if (!clearScript && !clearPrompt) {
    clearScript = true
    clearPrompt = true
  }
  return { path, clearScript, clearPrompt }
}

export async function runRepoSubcommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args
  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(`${REPO_USAGE}\n`)
    return
  }

  const { getRepoInitOverride, setRepoInitOverride, resolveRepoRoot } = await import("../state/repos.ts")
  const { existsSync } = await import("node:fs")
  const { join } = await import("node:path")

  if (verb === "show") {
    const [pathArg] = rest.filter((a) => !a.startsWith("-"))
    const repo = resolveRepoRoot(resolve(process.cwd(), pathArg ?? "."))
    const override = getRepoInitOverride(repo)
    const hasFileScript = existsSync(join(repo, ".kobe", "init.sh"))
    const hasFilePrompt = existsSync(join(repo, ".kobe", "init-prompt.md"))
    console.log(`repo: ${repo}`)
    console.log(`  .kobe/init.sh:        ${hasFileScript ? "present (wins)" : "absent"}`)
    console.log(`  .kobe/init-prompt.md: ${hasFilePrompt ? "present (wins)" : "absent"}`)
    console.log(`  override initScript:  ${override.initScript ? quotePreview(override.initScript) : "(unset)"}`)
    console.log(`  override initPrompt:  ${override.initPrompt ? quotePreview(override.initPrompt) : "(unset)"}`)
    return
  }

  if (verb === "set") {
    const flags = parseRepoArgs(rest)
    if (flags.initScript === undefined && flags.initPrompt === undefined) {
      usageError("set needs at least one of --init-script(-file) / --init-prompt(-file)")
    }
    const repo = resolveRepoRoot(resolve(process.cwd(), flags.path ?? "."))
    const next = setRepoInitOverride(repo, {
      ...(flags.initScript !== undefined ? { initScript: flags.initScript } : {}),
      ...(flags.initPrompt !== undefined ? { initPrompt: flags.initPrompt } : {}),
    })
    console.log(`updated override for ${repo}`)
    console.log(`  initScript: ${next.initScript ? quotePreview(next.initScript) : "(unset)"}`)
    console.log(`  initPrompt: ${next.initPrompt ? quotePreview(next.initPrompt) : "(unset)"}`)
    return
  }

  if (verb === "unset") {
    const { path, clearScript, clearPrompt } = parseUnsetArgs(rest)
    const repo = resolveRepoRoot(resolve(process.cwd(), path ?? "."))
    const next = setRepoInitOverride(repo, {
      ...(clearScript ? { initScript: "" } : {}),
      ...(clearPrompt ? { initPrompt: "" } : {}),
    })
    console.log(`cleared override for ${repo}`)
    console.log(`  initScript: ${next.initScript ? quotePreview(next.initScript) : "(unset)"}`)
    console.log(`  initPrompt: ${next.initPrompt ? quotePreview(next.initPrompt) : "(unset)"}`)
    return
  }

  usageError(`unknown verb "${verb}"`)
}

/** Single-line preview of a possibly multi-line value for `repo show`. */
function quotePreview(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > 60 ? `"${oneLine.slice(0, 57)}…"` : `"${oneLine}"`
}
