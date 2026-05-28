/**
 * Engine vendor identifier (v0.6).
 *
 * v0.5 supported `"claude" | "codex" | "gemini"` so the engine
 * registry could route per-task. v0.6 drops gemini entirely (no
 * interactive TUI equivalent worth wrapping) and keeps `"claude"`
 * + `"codex"` only because their on-disk history JSONL is what the
 * outer monitor reads for the live preview rail and cost dashboard.
 *
 * Per-task vendor is still recorded on Task so the monitor knows
 * which history-reader to call.
 */
export type VendorId = "claude" | "codex"

/**
 * Selectable vendors, in cycle order (the new-task dialog's `ctrl+e`
 * walks this). Extend here when a new engine is wired — keep it in sync
 * with `engine/interactive-command.ts` and the history-reader dispatch.
 */
export const ALL_VENDORS: readonly VendorId[] = ["claude", "codex"]

/** Next vendor in {@link ALL_VENDORS} order, wrapping around. */
export function nextVendor(current: VendorId): VendorId {
  const i = ALL_VENDORS.indexOf(current)
  return ALL_VENDORS[(i + 1) % ALL_VENDORS.length] ?? ALL_VENDORS[0]
}
