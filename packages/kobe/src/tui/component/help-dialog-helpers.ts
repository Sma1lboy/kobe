/**
 * Pure helpers used by `help-dialog.tsx`. Split out so vitest (Node
 * runtime) can unit-test them without importing `@opentui/core`.
 */

/**
 * Render a slash command name as the canonical `/<name>` label. Kept
 * as an exported helper for future slash-discovery surfaces; the
 * in-process help dialog stopped rendering a slash section in
 * sprint-7 when the chat pane moved out of the kobe TUI process.
 */
export function formatSlashLabel(name: string): string {
  return `/${name}`
}
