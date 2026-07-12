/**
 * Editor preference — pure constants + normalization, no IO / no tmux.
 *
 * Split out so the Settings dialog can
 * read/write the editor prefs via its reactive `kv` WITHOUT importing
 * `tmux/editor-launch.ts` (which pulls in the tmux client). The launcher
 * imports these same constants so both sides agree on the keys.
 *
 * `e` in the file tree opens the current file in this editor; `editor.kind`
 * picks which, `editor.customCommand` is the command for `kind === "custom"`.
 */

/**
 * Which editor the file tree's `e` key launches.
 *  - `auto`   — the STANDARD behaviour: honour $VISUAL / $EDITOR, and if
 *               neither is set, auto-detect the first installed of nvim →
 *               vim → emacs → nano. This is the default.
 *  - explicit `vim` / `nvim` / `nano` / `emacs` — force that editor.
 *  - `custom` — run `editor.customCommand` (e.g. `code -w`, `emacsclient`).
 */
export type EditorKind = "auto" | "vim" | "nvim" | "nano" | "emacs" | "custom"

/** Cycle order for the Settings select row. */
export const EDITOR_KINDS: readonly EditorKind[] = ["auto", "vim", "nvim", "nano", "emacs", "custom"]

/** Auto-detect probe order when $VISUAL / $EDITOR are unset. */
export const AUTO_EDITOR_CANDIDATES: readonly string[] = ["nvim", "vim", "emacs", "nano"]

/** Shared `state.json` keys. */
export const EDITOR_KIND_KEY = "editor.kind"
export const EDITOR_CUSTOM_KEY = "editor.customCommand"

/** Default when unset: follow the standard env / auto-detect. */
export const DEFAULT_EDITOR_KIND: EditorKind = "auto"

/** Coerce an unknown persisted value to a valid kind (default auto). */
export function normalizeEditorKind(value: unknown): EditorKind {
  return EDITOR_KINDS.includes(value as EditorKind) ? (value as EditorKind) : DEFAULT_EDITOR_KIND
}
