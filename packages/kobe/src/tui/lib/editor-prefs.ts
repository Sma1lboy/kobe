export type EditorKind = "auto" | "vim" | "nvim" | "nano" | "emacs" | "custom"

export const EDITOR_KINDS: readonly EditorKind[] = ["auto", "vim", "nvim", "nano", "emacs", "custom"]

export const AUTO_EDITOR_CANDIDATES: readonly string[] = ["nvim", "vim", "emacs", "nano"]

export const EDITOR_KIND_KEY = "editor.kind"
export const EDITOR_CUSTOM_KEY = "editor.customCommand"

export const DEFAULT_EDITOR_KIND: EditorKind = "auto"

export function normalizeEditorKind(value: unknown): EditorKind {
  return EDITOR_KINDS.includes(value as EditorKind) ? (value as EditorKind) : DEFAULT_EDITOR_KIND
}
