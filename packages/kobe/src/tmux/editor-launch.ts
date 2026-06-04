/**
 * External-editor launch for the Ops pane's file tree (`e` key).
 *
 * The file tree has two open actions:
 *   - `enter` → the in-TUI read-only preview/diff window (`openPreview`).
 *   - `e`     → THIS: open the file in the user's real editor (vim / nano
 *               / a custom command) in a fresh tmux window. When the
 *               editor exits, tmux closes the window and switches back —
 *               same transient-window pattern as the Settings page.
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
 * Settings (shared `state.json`, read cross-process via getPersistedString
 * since the Ops host is its own process):
 *   - `editor.kind`          "vim" | "nano" | "custom"   (default "vim")
 *   - `editor.customCommand` e.g. `code -w` / `emacsclient` / `subl -w {file}`
 */

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
 * `session-layout.ts` pulls its command builders out of the imperative
 * tmux calls.
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
 * Open `absPath` in the configured editor in a new tmux window of
 * `session`. Returns `true` if the editor was launched, `false` if it
 * couldn't be resolved / isn't installed (caller should fall back to the
 * read-only preview). Not keep-alive-wrapped: when the editor exits, tmux
 * closes the window and returns to the previous one.
 */
export async function openInEditor(session: string, worktree: string, absPath: string): Promise<boolean> {
  const resolved = await resolveEditorCommand(absPath)
  if (!resolved) return false
  if (!(await binaryAvailable(resolved.bin))) return false
  // Name the window after the FILE being edited (its basename), matching
  // the read-only preview window's labelling. With several files open this
  // is what tells the tmux window list apart; which editor it is, is
  // obvious from the editor's own UI.
  await newWindow(session, { cwd: worktree, command: resolved.command, name: editorWindowLabel(absPath) })
  return true
}

/** Basename of the file path, for the tmux window label (the edited file). */
export function editorWindowLabel(absPath: string): string {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1).trim()
  return base.length > 0 ? base : "edit"
}
