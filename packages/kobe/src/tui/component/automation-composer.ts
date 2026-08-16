/**
 * Framework-free state for the automation composer card — field order,
 * validation, and the schedule preview. No React, no opentui: the dialog
 * shell renders what these return.
 *
 * A cron expression is the one field a user cannot check by reading it back.
 * `0 9 * * MON-FRI` is only obviously right once something says "weekdays at
 * 09:00 — next Mon Aug 3, 09:00". So the composer answers that continuously
 * rather than letting the daemon reject a typo after the fact.
 */

import { isValidCron, nextCronAfter } from "@sma1lboy/kobe-daemon/daemon/cron"

/** Card fields, in tab order. `confirm` is the Create button. */
export type ComposerField = "name" | "repo" | "prompt" | "schedule" | "confirm"

export const COMPOSER_FIELDS: readonly ComposerField[] = ["name", "repo", "prompt", "schedule", "confirm"]

/** Tab / shift-tab, wrapping — the card is a loop, not a wizard with an end. */
export function nextComposerField(field: ComposerField, delta: 1 | -1 = 1): ComposerField {
  const index = COMPOSER_FIELDS.indexOf(field)
  if (index < 0) return "name"
  const next = (index + delta + COMPOSER_FIELDS.length) % COMPOSER_FIELDS.length
  return COMPOSER_FIELDS[next] as ComposerField
}

export interface ComposerDraft {
  readonly name: string
  readonly repo: string
  readonly prompt: string
  readonly schedule: string
}

export const EMPTY_DRAFT: ComposerDraft = { name: "", repo: "", prompt: "", schedule: "0 9 * * MON-FRI" }

/** Ready to submit? Every field carries something and the cron parses. */
export function canSubmitDraft(draft: ComposerDraft): boolean {
  return (
    draft.name.trim().length > 0 &&
    draft.repo.trim().length > 0 &&
    draft.prompt.trim().length > 0 &&
    isValidCron(draft.schedule.trim())
  )
}

/**
 * Which field to jump to when submit is refused — the first incomplete one.
 * Never `confirm`: the button is not a thing that can be blank, so the return
 * type says so and no caller has to look up a message that cannot exist.
 */
export function firstIncompleteField(draft: ComposerDraft): Exclude<ComposerField, "confirm"> | null {
  if (draft.name.trim().length === 0) return "name"
  if (draft.repo.trim().length === 0) return "repo"
  if (draft.prompt.trim().length === 0) return "prompt"
  if (!isValidCron(draft.schedule.trim())) return "schedule"
  return null
}

export type SchedulePreview =
  | { readonly kind: "invalid" }
  /** Parses but never fires (`0 0 30 2 *`) — valid syntax, useless schedule. */
  | { readonly kind: "never" }
  | { readonly kind: "ok"; readonly nextRunMs: number; readonly relative: string; readonly absolute: string }

/**
 * What the schedule field shows beneath itself: the next fire time in the
 * user's own timezone, phrased both ways. "in 14h" answers "is this soon?",
 * the absolute stamp answers "is this the time I meant?" — a cron typo
 * usually shows up as one of the two reading wrong.
 */
export function previewSchedule(expression: string, nowMs: number): SchedulePreview {
  const trimmed = expression.trim()
  if (!isValidCron(trimmed)) return { kind: "invalid" }
  let nextRunMs: number
  try {
    nextRunMs = nextCronAfter(trimmed, nowMs)
  } catch {
    return { kind: "never" }
  }
  return {
    kind: "ok",
    nextRunMs,
    relative: formatRelative(nextRunMs - nowMs),
    absolute: formatAbsolute(nextRunMs, nowMs),
  }
}

function formatRelative(deltaMs: number): string {
  // Floor every bucket, matching the elapsed formatter (`formatAgo`): a
  // countdown reads "in Nh" as *at least* N hours away, so rounding up would
  // promise headroom that isn't there — 90 minutes out is "in 1h", not "in 2h".
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000))
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/**
 * Local wall-clock, at the coarsest useful precision: `09:00` when it fires
 * today, `Mon 09:00` within the week, `Mon Aug 3, 09:00` beyond it. The date
 * is what disambiguates a schedule; repeating today's is noise.
 */
function formatAbsolute(atMs: number, nowMs: number): string {
  const at = new Date(atMs)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  const now = new Date(nowMs)
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  if (sameDay) return time
  const weekday = WEEKDAYS[at.getDay()] ?? ""
  if (atMs - nowMs < 6 * 24 * 60 * 60 * 1000) return `${weekday} ${time}`
  return `${weekday} ${MONTHS[at.getMonth()] ?? ""} ${at.getDate()}, ${time}`
}
