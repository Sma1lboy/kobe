/**
 * Resolve chat composer placeholder copy without importing opentui UI
 * modules. Kept pure so tests can cover the visual state contract.
 */
export function resolvePlaceholder(opts: {
  isStreaming: boolean
  hasTask: boolean
  noTaskMessage?: string
  inputPlaceholder?: string
}): string {
  if (!opts.hasTask) return opts.noTaskMessage ?? "(no task — press n to create)"
  if (opts.isStreaming) return ""
  return opts.inputPlaceholder ?? "Ask Claude…"
}
