import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { getPersistedString } from "@/state/repos"
import {
  AUTO_EDITOR_CANDIDATES,
  EDITOR_CUSTOM_KEY,
  EDITOR_KIND_KEY,
  type EditorKind,
  normalizeEditorKind,
} from "@/tui/lib/editor-prefs"
import { newWindow } from "./client"
import { shellQuote } from "./session-layout"

const FILE_PLACEHOLDER = "{file}"

function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? ""
}

export function buildEditorCommand(
  kind: EditorKind,
  customCommand: string,
  absPath: string,
  envEditor?: string,
): { bin: string; command: string } | null {
  const file = shellQuote(absPath)
  if (kind === "vim") return { bin: "vim", command: `vim ${file}` }
  if (kind === "nvim") return { bin: "nvim", command: `nvim ${file}` }
  if (kind === "nano") return { bin: "nano", command: `nano ${file}` }
  if (kind === "emacs") return { bin: "emacs", command: `emacs ${file}` }

  const tmpl = (customCommand.trim() || (envEditor ?? "").trim()).trim()
  if (!tmpl) return null
  const bin = firstToken(tmpl)
  if (!bin) return null
  const command = tmpl.includes(FILE_PLACEHOLDER) ? tmpl.split(FILE_PLACEHOLDER).join(file) : `${tmpl} ${file}`
  return { bin, command }
}

export function buildNvimDiffCommand(bin: string, absPath: string, relPath: string): string {
  const file = shellQuote(absPath)
  const head = shellQuote(`HEAD:./${relPath}`)
  return [
    "f=$(mktemp 2>/dev/null)",
    `if [ -n "$f" ] && git show ${head} > "$f" 2>/dev/null; then`,
    `  ${bin} -d "$f" ${file} -c 'setlocal nomodifiable' -c 'wincmd l'; r=$?`,
    "else",
    `  ${bin} ${file}; r=$?`,
    "fi",
    'rm -f "$f" 2>/dev/null; exit $r',
  ].join("\n")
}

export function relativeToWorktree(worktree: string, absPath: string): string | null {
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : null
}

export async function resolveEditorCommand(absPath: string): Promise<{ bin: string; command: string } | null> {
  const kind = normalizeEditorKind(getPersistedString(EDITOR_KIND_KEY))
  const custom = getPersistedString(EDITOR_CUSTOM_KEY) ?? ""
  const env = (process.env.VISUAL ?? process.env.EDITOR ?? "").trim()
  if (kind !== "auto") return buildEditorCommand(kind, custom, absPath, env)
  if (env) return buildEditorCommand("custom", "", absPath, env)
  const file = shellQuote(absPath)
  for (const bin of AUTO_EDITOR_CANDIDATES) {
    if (await binaryAvailable(bin)) return { bin, command: `${bin} ${file}` }
  }
  return null
}

export async function binaryAvailable(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${shellQuote(bin)} >/dev/null 2>&1`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export async function fileHasDiff(worktree: string, relPath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "diff", "--quiet", "HEAD", "--", relPath], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: readOnlyGitProcessEnv(),
    })
    return (await proc.exited) === 1
  } catch {
    return false
  }
}

export async function resolveEditorLaunch(
  worktree: string,
  absPath: string,
): Promise<{ command: string; label: string } | null> {
  const resolved = await resolveEditorCommand(absPath)
  if (!resolved) return null
  if (!(await binaryAvailable(resolved.bin))) return null
  const command = await maybeDiffCommand(resolved, worktree, absPath)
  return { command, label: editorWindowLabel(absPath) }
}

export async function openInEditor(session: string, worktree: string, absPath: string): Promise<boolean> {
  const launch = await resolveEditorLaunch(worktree, absPath)
  if (!launch) return false
  await newWindow(session, { cwd: worktree, command: launch.command, name: launch.label })
  return true
}

async function maybeDiffCommand(
  resolved: { bin: string; command: string },
  worktree: string,
  absPath: string,
): Promise<string> {
  const { bin, command } = resolved
  if (bin !== "nvim" && bin !== "vim") return command
  if (command !== `${bin} ${shellQuote(absPath)}`) return command
  const rel = relativeToWorktree(worktree, absPath)
  if (!rel) return command
  if (!(await fileHasDiff(worktree, rel))) return command
  return buildNvimDiffCommand(bin, absPath, rel)
}

export function editorWindowLabel(absPath: string): string {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1).trim()
  return base.length > 0 ? base : "edit"
}
