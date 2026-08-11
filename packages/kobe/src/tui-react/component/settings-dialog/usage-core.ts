/**
 * Framework-free view model for the Settings usage dashboard (General,
 * top-right corner): turns the daemon's `usage.snapshot` windows into
 * aligned meter rows. Pure — the React component only maps rows to <text>.
 */

import { ratioBar } from "../../../tui/lib/progress-bar.ts"
import type { EngineQuotaUsage } from "../../../types/engine.ts"

/** Meter track width in cells. */
export const USAGE_BAR_WIDTH = 10

/** Severity tone → theme color pick happens in the component. */
export type UsageTone = "ok" | "warn" | "crit"

export interface UsageRowView {
  readonly label: string
  readonly bar: string
  readonly percentText: string
  readonly resetText: string
  readonly tone: UsageTone
}

const toneOf = (percent: number): UsageTone => (percent >= 95 ? "crit" : percent >= 75 ? "warn" : "ok")

const pad2 = (n: number): string => String(n).padStart(2, "0")

/**
 * Compact local-time reset stamp: within 24h just the clock ("→ 14:00"),
 * beyond that day+clock ("→ 7/30 14:00"), empty when the vendor reported
 * no reset. Numeric-only on purpose — no locale words to translate.
 */
export function formatReset(resetsAt: number | null, nowMs: number): string {
  if (resetsAt == null || resetsAt <= nowMs) return ""
  const d = new Date(resetsAt)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (resetsAt - nowMs < 24 * 60 * 60 * 1000) return `→ ${clock}`
  return `→ ${d.getMonth() + 1}/${d.getDate()} ${clock}`
}

/**
 * One window rendered as a compact chip (the workspace footer line), split
 * into segments so the footer can color the percent by tone — mirroring the
 * Settings dashboard — while label/reset stay muted.
 */
export interface UsageChipView {
  readonly label: string
  readonly percentText: string
  readonly resetText: string
  readonly tone: UsageTone
}

/**
 * Bar-less one-line form of {@link usageRows} for the workspace footer:
 * `5h 42% → 14:00`. Same tone thresholds, no padding — the footer packs
 * several vendors onto one row, so every cell has to earn its width.
 */
export function usageChips(usage: EngineQuotaUsage, nowMs: number): UsageChipView[] {
  return usage.windows.map((w) => ({
    label: w.label,
    percentText: `${w.percent}%`,
    resetText: formatReset(w.resetsAt, nowMs),
    tone: toneOf(w.percent),
  }))
}

/**
 * Narrow-footer form (issue #14): ONE chip per vendor, pinned to the
 * session window — the "5h" rolling window every vendor reports as its
 * tightest budget — falling back to the vendor's first window when no
 * session window exists. Reset time is dropped; at 46 cols only the
 * tone-colored percent earns its cells.
 */
export function narrowUsageChip(usage: EngineQuotaUsage, nowMs: number): UsageChipView | null {
  const w = usage.windows.find((win) => win.kind === "session") ?? usage.windows[0]
  if (!w) return null
  return {
    label: w.label,
    percentText: `${w.percent}%`,
    resetText: formatReset(w.resetsAt, nowMs),
    tone: toneOf(w.percent),
  }
}

/**
 * One aligned meter row per quota window, in the vendor's own order (the
 * usage API lists session before weekly). Label column width tracks the
 * longest label (scoped windows carry model display names) with a hard cap
 * so one long name can't push the meters off the dialog.
 */
export function usageRows(usage: EngineQuotaUsage, nowMs: number): UsageRowView[] {
  const labelWidth = Math.min(
    8,
    usage.windows.reduce((w, win) => Math.max(w, win.label.length), 2),
  )
  return usage.windows.map((w) => ({
    label: (w.label.length > labelWidth ? w.label.slice(0, labelWidth) : w.label).padEnd(labelWidth),
    bar: ratioBar(w.percent / 100, USAGE_BAR_WIDTH),
    percentText: `${String(w.percent).padStart(3)}%`,
    resetText: formatReset(w.resetsAt, nowMs),
    tone: toneOf(w.percent),
  }))
}
