/**
 * Resolve chat composer placeholder copy without importing opentui UI or
 * either framework's i18n runtime. Kept pure so tests can cover the visual
 * state contract.
 *
 * `translate` is injected: the Solid composer view passes the module `t`,
 * the React one passes its `useT()` function — the two runtimes hold
 * separate locale stores, so the fallback copy must resolve in the caller's.
 */
export function resolvePlaceholder(
  opts: {
    isStreaming: boolean
    hasTask: boolean
    noTaskMessage?: string
    inputPlaceholder?: string
  },
  translate: (key: string) => string,
): string {
  if (!opts.hasTask) return opts.noTaskMessage ?? translate("chat.composer.noTask")
  if (opts.isStreaming) return ""
  return opts.inputPlaceholder ?? translate("chat.composer.askFallback")
}
