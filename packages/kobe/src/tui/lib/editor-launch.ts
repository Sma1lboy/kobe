/**
 * External-editor launch for the Ops pane's file tree (`e` key).
 *
 * The file tree has two open actions:
 *   - `enter` → the in-TUI read-only preview/diff window (`openPreview`).
 *   - `e`     → THIS: open the file in the user's real editor (vim / nano
 *               / a custom command) in an embedded command tab.
 *
 * Why shell out instead of editing in-pane: the preview is an opentui
 * `<code>`/`<diff>` renderer with no cursor/insert/save. A real editable
 * buffer would mean reimplementing a text editor in the TUI; launching
 * vim/nano/$EDITOR is what lazygit/gitui do and it's strictly better.
 *
 * Fallback chain (KOB — file-editor-launch): if the configured editor's
 * binary isn't on PATH (or `custom` is empty with no `$EDITOR`), this
 * returns `false` and the caller falls back to the read-only preview, so
 * `e` is never a dead key. We gate on "binary missing", NOT on the
 * editor's exit code — a `:cq` / non-zero quit is a real edit session,
 * not a launch failure, and must not bounce to preview.
 *
 * nvim/vim diff mode: when the resolved editor is a PLAIN nvim/vim open
 * (`<bin> <file>`, no custom flags) AND the file differs from HEAD, `e`
 * upgrades to side-by-side diff mode — the committed HEAD blob read-only
 * on the left, the live editable file on the right. This is the sh-`-c`
 * safe form of `nvim -d <file> <(git show HEAD:<file>)`: tmux runs the
 * window via `sh -c`, which has no `<(…)` process substitution, so the
 * HEAD blob is dumped to a tmp file (the explicit stand-in for the
 * process-substitution fd) and `rm`-ed when the editor exits. Nothing
 * touches the user's nvim config or the repo — zero-install, zero-config.
 * A custom command with its own flags is never rewritten.
 *
 * Settings (shared `state.json`, read cross-process via getPersistedString
 * since the Ops host is its own process):
 *   - `editor.kind`          "vim" | "nano" | "custom"   (default "vim")
 *   - `editor.customCommand` e.g. `code -w` / `emacsclient` / `subl -w {file}`
 */

import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { quoteShellArg as shellQuote } from "@/lib/shell-command"
import { getPersistedString } from "@/state/repos"
import {
  AUTO_EDITOR_CANDIDATES,
  EDITOR_CUSTOM_KEY,
  EDITOR_KIND_KEY,
  type EditorKind,
  normalizeEditorKind,
} from "@/tui/lib/editor-prefs"

/** Token replaced with the (shell-quoted) file path in a custom command. */
const FILE_PLACEHOLDER = "{file}"

/** First whitespace-delimited token of a command (the binary to probe). */
function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? ""
}

/**
 * Pure: build the shell command that opens `absPath` in the chosen editor.
 * Returns `null` when nothing usable is configured (caller → preview).
 *
 * - vim / nano → `<bin> '<abs>'`
 * - custom     → `customCommand`, with `{file}` substituted by the quoted
 *                path, or the quoted path appended when no placeholder is
 *                present. Empty custom falls back to `envEditor`
 *                (`$VISUAL` / `$EDITOR`), then `null`.
 *
 * Kept pure (inputs in, strings out — no IO) so the quoting / substitution
 * / fallback policy is unit-testable without a state.json, the same way
 * the launcher stays independent from terminal ownership.
 */
export function buildEditorCommand(
  kind: EditorKind,
  customCommand: string,
  absPath: string,
  envEditor?: string,
): { bin: string; command: string } | null {
  const file = shellQuote(absPath)
  // Explicit terminal editors map straight to their binary.
  if (kind === "vim") return { bin: "vim", command: `vim ${file}` }
  if (kind === "nvim") return { bin: "nvim", command: `nvim ${file}` }
  if (kind === "nano") return { bin: "nano", command: `nano ${file}` }
  if (kind === "emacs") return { bin: "emacs", command: `emacs ${file}` }

  // `custom` (and the `auto` env path, which reuses this with envEditor as the
  // template): the user's command, or $VISUAL/$EDITOR.
  const tmpl = (customCommand.trim() || (envEditor ?? "").trim()).trim()
  if (!tmpl) return null
  const bin = firstToken(tmpl)
  if (!bin) return null
  const command = tmpl.includes(FILE_PLACEHOLDER) ? tmpl.split(FILE_PLACEHOLDER).join(file) : `${tmpl} ${file}`
  return { bin, command }
}

/**
 * Pure: the sh command that opens `absPath` in nvim/vim's built-in diff
 * mode (`-d`) against its committed HEAD version.
 *
 * The command runs via `sh -c`, which has no `<(…)` process
 * substitution, so we materialise bash's `<(git show HEAD:<file>)` as a
 * mktemp file: dump the HEAD blob into it, `nvim -d "$tmp" <file>` (HEAD
 * read-only on the LEFT, live editable file on the RIGHT, cursor parked on
 * the right), then `rm` it on exit. A single sh layer — every path is
 * `shellQuote`d here, with no second shell-in-nvim parse to re-escape.
 *
 * `relPath` is worktree-relative; `HEAD:./<rel>` pins the blob lookup to
 * the worktree cwd. If the HEAD blob can't be read (e.g. a race removed
 * the diff between the check and the launch), it falls back to a plain
 * `<bin> <file>` open so `e` still lands in an editor.
 */
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

/**
 * Worktree-relative form of `absPath`, or `null` when it isn't under
 * `worktree` (then the diff upgrade is skipped and we just open the file).
 */
export function relativeToWorktree(worktree: string, absPath: string): string | null {
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : null
}

/**
 * Resolve the editor command from persisted settings + env (the IO wrapper
 * around {@link buildEditorCommand}). Read cross-process via
 * getPersistedString since the Ops host is its own process.
 *
 * The default kind is `auto`, which follows the STANDARD convention: prefer
 * $VISUAL / $EDITOR, and if neither is set, auto-detect the first installed of
 * {@link AUTO_EDITOR_CANDIDATES} (nvim → vim → emacs → nano). That detection is
 * why this is async. Explicit kinds resolve synchronously via buildEditorCommand.
 */
export async function resolveEditorCommand(absPath: string): Promise<{ bin: string; command: string } | null> {
  const kind = normalizeEditorKind(getPersistedString(EDITOR_KIND_KEY))
  const custom = getPersistedString(EDITOR_CUSTOM_KEY) ?? ""
  const env = (process.env.VISUAL ?? process.env.EDITOR ?? "").trim()
  if (kind !== "auto") return buildEditorCommand(kind, custom, absPath, env)
  // auto: honour the standard env first…
  if (env) return buildEditorCommand("custom", "", absPath, env)
  // …else probe for an installed terminal editor, in preference order.
  const file = shellQuote(absPath)
  for (const bin of AUTO_EDITOR_CANDIDATES) {
    if (await binaryAvailable(bin)) return { bin, command: `${bin} ${file}` }
  }
  return null
}

/** Is `bin` resolvable on PATH (or as an absolute path)? Pre-flight for fallback. */
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

/**
 * Does `relPath` differ from its HEAD version? Gate for the nvim/vim diff
 * upgrade. `git diff --quiet` exits 1 on differences, 0 on none; we treat
 * ONLY exit 1 as "has diff" so an untracked/new file (exit 0 — no HEAD
 * blob to diff) or a git error (other codes) opens plain, not in diff mode.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps it lock-free, matching the read-only preview
 * (`tui/ops/host.tsx` gitDiff) — it must not take `.git/index.lock` and
 * race the worktree's engine commits.
 */
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

/**
 * Resolve + (maybe) diff-upgrade the editor command for `absPath`, without
 * launching it. The workspace runs the result in an embedded terminal tab.
 * Returns `null` when nothing usable is configured/installed
 * (caller falls back to the read-only preview / an external opener).
 */
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

/**
 * Upgrade a resolved editor command to nvim/vim side-by-side diff mode when
 * it's a PLAIN nvim/vim open of a file that differs from HEAD; otherwise
 * return it unchanged.
 *
 * Gated on the command being EXACTLY the simple `<bin> <file>` form: an
 * explicit `vim`/`nvim` kind, an auto-detected one, or `$EDITOR=nvim` all
 * resolve to that, while a custom command carrying its own flags
 * (`nvim -u … {file}`) does not match and is left untouched — we never
 * rewrite a user's deliberate invocation.
 */
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

/** Basename of the file path, used as the editor tab label. */
export function editorWindowLabel(absPath: string): string {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1).trim()
  return base.length > 0 ? base : "edit"
}
