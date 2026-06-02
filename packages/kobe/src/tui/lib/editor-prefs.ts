/**
 * Editor preference — pure constants + normalization, no IO / no tmux.
 *
 * Split out (mirroring `settings-surface.ts`) so the Settings dialog can
 * read/write the editor prefs via its reactive `kv` WITHOUT importing
 * `tmux/editor-launch.ts` (which pulls in the tmux client). The launcher
 * imports these same constants so both sides agree on the keys.
 *
 * `e` in the file tree opens the current file in this editor; `editor.kind`
 * picks which, `editor.customCommand` is the command for `kind === "custom"`.
 */

/** Which editor the file tree's `e` key launches. */
export type EditorKind = "vim" | "nano" | "custom"

/** Cycle order for the Settings select row. */
export const EDITOR_KINDS: readonly EditorKind[] = ["vim", "nano", "custom"]

/** Shared `state.json` keys. */
export const EDITOR_KIND_KEY = "editor.kind"
export const EDITOR_CUSTOM_KEY = "editor.customCommand"

/** Default when unset: the most universally-present terminal editor. */
export const DEFAULT_EDITOR_KIND: EditorKind = "vim"

/** Coerce an unknown persisted value to a valid kind (default vim). */
export function normalizeEditorKind(value: unknown): EditorKind {
  return value === "nano" || value === "custom" || value === "vim" ? value : DEFAULT_EDITOR_KIND
}
