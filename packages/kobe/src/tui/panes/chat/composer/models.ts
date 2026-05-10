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
 * Order is the order shown in the picker. Default fallback (no model
 * pinned, claude-code picks) lives at the top so the user can always
 * un-pin without scrolling.
 */
export type ModelChoice = {
  /** Anthropic model id passed to `claude --model`. `undefined` = leave the flag off. */
  readonly id: string | undefined
  /** Short label shown in the composer footer + picker. */
  readonly label: string
  /** Optional one-liner shown next to the label in the picker. */
  readonly hint?: string
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: undefined, label: "claude-code", hint: "use the CLI's default model" },
  { id: "claude-opus-4-7", label: "opus 4.7", hint: "most capable, slowest" },
  { id: "claude-sonnet-4-6", label: "sonnet 4.6", hint: "balanced default" },
  { id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fastest, cheapest" },
] as const

/**
 * Resolve the display label for a stored model id. Falls back to the
 * id verbatim when the user has pinned a model not in our shortlist
 * (e.g. typed in via a future free-text path) so the footer always
 * shows *something* meaningful.
 */
export function modelLabelFor(id: string | undefined): string {
  if (id === undefined) return "claude-code"
  const match = MODEL_CHOICES.find((m) => m.id === id)
  return match?.label ?? id
}
