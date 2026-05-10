/**
 * Models offered by the composer's model picker.
 *
 * The `id` is what we pass to `claude --model <id>` (forwarded verbatim
 * by the orchestrator → spawn pipeline). The `label` is what the user
 * sees in the composer footer and the picker dialog. Anthropic publishes
 * model ids and ships new ones regularly — when an id is rotated, edit
 * this list rather than relying on aliases (`opus`/`sonnet`), which the
 * CLI resolves to the latest of a family at *its* runtime, not ours,
 * and would make the displayed label drift away from what the engine
 * actually loaded.
 *
 * No "default / claude-code" pseudo-entry: claude-code itself doesn't
 * surface one — the unpinned state simply resolves to the real default
 * model (Sonnet 4.6 for PAYG/Pro/Enterprise/Team Standard, per
 * `getDefaultMainLoopModelSetting` in refs/claude-code/src/utils/model/
 * model.ts). The footer shows that real name; the picker lists real
 * models only.
 */
export type ModelChoice = {
  /** Anthropic model id passed to `claude --model`. */
  readonly id: string
  /** Short label shown in the composer footer + picker. */
  readonly label: string
  /** Optional one-liner shown next to the label in the picker. */
  readonly hint?: string
}

/**
 * The model id used when a task has no explicit pin. Mirrors claude-code's
 * `getDefaultSonnetModel()` for non-Ant non-Max users — the dominant case
 * for kobe. We don't pass `--model` to the CLI in that state (so Max users
 * still get Opus from the CLI's own resolution); this constant is only
 * for the displayed label.
 */
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6"

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: "claude-opus-4-7", label: "opus 4.7", hint: "most capable, slowest" },
  { id: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fastest, cheapest" },
] as const

/**
 * Resolve the display label for a stored model id. When unset, returns
 * the label for {@link DEFAULT_MODEL_ID}. Falls back to the id verbatim
 * when the user has pinned a model not in our shortlist (e.g. typed in
 * via a future free-text path) so the footer always shows *something*
 * meaningful.
 */
export function modelLabelFor(id: string | undefined): string {
  const resolved = id ?? DEFAULT_MODEL_ID
  const match = MODEL_CHOICES.find((m) => m.id === resolved)
  return match?.label ?? resolved
}
