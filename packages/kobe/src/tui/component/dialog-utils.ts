/**
 * Shared utilities for kobe's dialog components (v0.6).
 *
 * v0.5 had these scattered across new-task-dialog/state.ts and
 * rename-task-dialog. v0.6 dialogs are smaller (no clone tab, no
 * branch picker, no model picker) so a single tiny file is fine.
 */

/**
 * opentui's `<input>` inserts a literal `\n` on Enter — we always
 * want Enter to commit, not to type a newline. Strip both CR and LF
 * so a paste of `foo\r\nbar` becomes `foobar` too.
 */
export function stripNewlines(v: string): string {
  return v.replace(/[\r\n]+/g, "")
}
