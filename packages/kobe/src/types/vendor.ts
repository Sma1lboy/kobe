/**
 * Engine vendor identifier.
 *
 * One of: `"claude"` (the only one wired up today, served by
 * `engine/claude-code-local/`), plus future entrants (`"codex"`, …).
 *
 * Where this surfaces:
 *   - `ModelChoice.vendor` so the composer picker can group / filter
 *   - Future `AIEngine` registry keyed by vendor (not built yet)
 *
 * Persisted `Task.model` stays a free-form string id (e.g.
 * `"claude-opus-4-7[1m]"`, `"gpt-5-codex"`). The vendor is inferable
 * from the picker entry the user chose; we don't double-persist it.
 */
export type VendorId = "claude" | "codex"
