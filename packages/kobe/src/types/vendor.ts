/**
 * Engine vendor identifier (v0.6).
 *
 * v0.5 supported `"claude" | "codex" | "gemini"` so the engine
 * registry could route per-task. v0.6 drops gemini entirely (no
 * interactive TUI equivalent worth wrapping) and keeps the engines
 * whose interactive CLI runs inside the tmux pane and whose on-disk
 * history JSONL the outer monitor reads for the live preview rail and
 * cost dashboard: `"claude"`, `"codex"`, and `"copilot"` (GitHub
 * Copilot CLI, ported into the v0.6 shape in KOB-249).
 *
 * Per-task vendor is still recorded on Task so the monitor knows
 * which history-reader to call.
 */
export type VendorId = "claude" | "codex" | "copilot"

/**
 * Selectable vendors, in cycle order (the new-task dialog's `ctrl+e`
 * walks this). Extend here when a new engine is wired — keep it in sync
 * with `engine/interactive-command.ts` and the history-reader dispatch.
 */
export const ALL_VENDORS: readonly VendorId[] = ["claude", "codex", "copilot"]

/** Next vendor in {@link ALL_VENDORS} order, wrapping around. */
export function nextVendor(current: VendorId): VendorId {
  const i = ALL_VENDORS.indexOf(current)
  return ALL_VENDORS[(i + 1) % ALL_VENDORS.length] ?? ALL_VENDORS[0]
}

/**
 * Next vendor within an arbitrary subset (e.g. the detected-only list the
 * new-task dialog renders), wrapping around. `current` need not be in the
 * list — cycling starts from the first entry. Empty list returns `current`
 * unchanged so a caller with nothing detected never crashes.
 */
export function nextVendorWithin(list: readonly VendorId[], current: VendorId): VendorId {
  if (list.length === 0) return current
  const i = list.indexOf(current)
  return list[(i + 1) % list.length] ?? list[0] ?? current
}

/**
 * Coerce an untrusted string (a CLI flag, a persisted record) to a
 * {@link VendorId}, falling back to `"claude"` for anything unrecognised
 * or absent — the same default the rest of v0.6 assumes when a task has
 * no recorded vendor.
 */
export function coerceVendorId(value: string | undefined): VendorId {
  return ALL_VENDORS.includes(value as VendorId) ? (value as VendorId) : "claude"
}
