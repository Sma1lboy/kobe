/**
 * Resolve chat composer placeholder copy without importing opentui UI
 * modules. Kept pure so tests can cover the visual state contract.
 */
import { t } from "@/tui/i18n"
export function resolvePlaceholder(opts: {
  isStreaming: boolean
  hasTask: boolean
  noTaskMessage?: string
  inputPlaceholder?: string
}): string {
  if (!opts.hasTask) return opts.noTaskMessage ?? t("chat.composer.noTask")
  if (opts.isStreaming) return ""
  return opts.inputPlaceholder ?? t("chat.composer.askFallback")
}
