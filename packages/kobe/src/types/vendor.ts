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
