/**
 * Codex subscription-quota probe. Unlike Claude's there is no endpoint to
 * call: the Codex CLI already records the server's `rate_limits` block on
 * every `token_count` event it writes to its rollout JSONL, so the freshest
 * numbers are sitting on disk. Reading the newest rollouts is the whole
 * probe — no network, no auth, nothing to rate-limit.
 *
 * Because it is a SNAPSHOT of the last response Codex received, a window
 * whose `resets_at` has already passed says nothing about the current one;
 * those are dropped, and a rollout set with nothing live yields `null` (the
 * usage dashboard then simply omits Codex).
 */

import type { EngineQuotaUsage, EngineQuotaWindow } from "@/types/engine"
import { type HistoryDeps, defaultHistoryDeps, listRolloutFiles } from "./history"

/** Newest rollouts scanned before giving up — a session that never made a
 *  request carries no `rate_limits` line, so look past the first few. */
const MAX_ROLLOUTS_SCANNED = 5

interface CodexRateWindow {
  readonly used_percent?: number
  readonly window_minutes?: number
  readonly resets_at?: number | null
}

interface CodexRateLimits {
  readonly primary?: CodexRateWindow | null
  readonly secondary?: CodexRateWindow | null
}

/** `window_minutes` → the same short label vocabulary Claude's probe uses. */
function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function toWindow(kind: string, raw: CodexRateWindow | null | undefined, nowMs: number): EngineQuotaWindow | null {
  if (!raw || typeof raw.used_percent !== "number" || typeof raw.window_minutes !== "number") return null
  // resets_at is epoch SECONDS. A window that already reset is a stale
  // reading, not a live one — the percent it carries belongs to a window
  // that no longer exists.
  const resetsAt = typeof raw.resets_at === "number" && raw.resets_at > 0 ? raw.resets_at * 1000 : null
  if (resetsAt == null || resetsAt <= nowMs) return null
  return {
    kind,
    label: windowLabel(raw.window_minutes),
    percent: Math.min(100, Math.max(0, Math.round(raw.used_percent))),
    resetsAt,
  }
}

/**
 * Last `rate_limits` block in one rollout's raw JSONL, normalized. Scans
 * lines back-to-front so a long session costs one `JSON.parse` instead of
 * one per turn. Returns null when the file has no usable live window.
 */
export function usageFromRolloutRaw(raw: string, nowMs: number): EngineQuotaUsage | null {
  const lines = raw.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"rate_limits"')) continue
    let limits: CodexRateLimits | undefined
    try {
      limits = (JSON.parse(line) as { payload?: { rate_limits?: CodexRateLimits } }).payload?.rate_limits
    } catch {
      continue
    }
    if (!limits) continue
    const windows = [toWindow("primary", limits.primary, nowMs), toWindow("secondary", limits.secondary, nowMs)].filter(
      (w): w is EngineQuotaWindow => w != null,
    )
    if (windows.length) return { windows, capturedAt: nowMs }
  }
  return null
}

/**
 * Snapshot of the Codex account's quota windows, or null when none can be
 * read (no sessions, no request made yet, every window already reset).
 * Never throws.
 */
export async function fetchCodexQuotaUsage(
  now: () => number = Date.now,
  deps: HistoryDeps = defaultHistoryDeps,
): Promise<EngineQuotaUsage | null> {
  try {
    const files = (await listRolloutFiles(deps)).slice(0, MAX_ROLLOUTS_SCANNED)
    for (const file of files) {
      const usage = usageFromRolloutRaw(await deps.readFile(file), now())
      if (usage) return usage
    }
  } catch {
    // unreadable ~/.codex — same "no probe" outcome as no login
  }
  return null
}
