/**
 * A cron expression as five editable segments — ←/→ moves between them, ↑/↓
 * changes the one under the cursor.
 *
 * Typing `0 9 * * MON-FRI` into a text field means knowing the field order and
 * the syntax before you can express anything, and a typo only surfaces when
 * the preview goes red. Segments make the structure visible and every edit
 * legal by construction.
 *
 * ↑/↓ walks a LADDER of useful values, not the whole numeric range: stepping
 * a minute field through 0..59 to reach 30 is not editing, it is scrolling.
 * The ladder holds `*`, the common divisors as `*\/n`, and the plain numbers —
 * so the reachable set is small and each rung means something on its own.
 */

/** Which of the five cron fields a segment is. Index = position. */
export const CRON_SEGMENTS = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"] as const
export type CronSegment = (typeof CRON_SEGMENTS)[number]

/** Split an expression into exactly five parts, padding a short one with `*`. */
export function splitCron(expression: string): string[] {
  const parts = expression.trim().split(/\s+/).filter(Boolean)
  return CRON_SEGMENTS.map((_, index) => parts[index] ?? "*")
}

export function joinCron(parts: readonly string[]): string {
  return CRON_SEGMENTS.map((_, index) => parts[index] ?? "*").join(" ")
}

const MINUTE_LADDER = ["*", "*/5", "*/10", "*/15", "*/30", ...range(0, 59)]
const HOUR_LADDER = ["*", "*/2", "*/3", "*/4", "*/6", "*/12", ...range(0, 23)]
const DOM_LADDER = ["*", ...range(1, 31)]
const MONTH_LADDER = ["*", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
// Weekday ranges lead: "weekdays" and "weekends" are how people actually
// describe a schedule, and neither is reachable by stepping single days.
const DOW_LADDER = ["*", "MON-FRI", "SAT,SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

function range(from: number, to: number): string[] {
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(String(n))
  return out
}

const LADDERS: Record<CronSegment, readonly string[]> = {
  minute: MINUTE_LADDER,
  hour: HOUR_LADDER,
  dayOfMonth: DOM_LADDER,
  month: MONTH_LADDER,
  dayOfWeek: DOW_LADDER,
}

/** Every value ↑/↓ can reach for `segment`, in rung order. */
export function ladderFor(segment: CronSegment): readonly string[] {
  return LADDERS[segment]
}

/**
 * Step one segment's value by `delta`, wrapping.
 *
 * A hand-typed value that is not on the ladder (`17-23`, `1,15`) is kept
 * reachable by landing on the nearest end rather than being silently
 * rewritten — the segments are an aid, not a restriction on what can be typed.
 */
export function stepSegment(segment: CronSegment, current: string, delta: 1 | -1): string {
  const ladder = LADDERS[segment]
  const index = ladder.indexOf(current.trim().toUpperCase())
  if (index < 0) return (delta > 0 ? ladder[0] : ladder[ladder.length - 1]) ?? current
  const next = (index + delta + ladder.length) % ladder.length
  return ladder[next] ?? current
}

/** Move the segment cursor, clamped — the row has ends, not a wrap-around. */
export function moveSegmentCursor(cursor: number, delta: 1 | -1): number {
  return Math.min(Math.max(cursor + delta, 0), CRON_SEGMENTS.length - 1)
}

/** Replace one segment, returning the whole expression. */
export function setSegment(expression: string, index: number, value: string): string {
  const parts = splitCron(expression)
  if (index < 0 || index >= CRON_SEGMENTS.length) return joinCron(parts)
  parts[index] = value
  return joinCron(parts)
}

/**
 * Human-readable phrase for the WHOLE expression, when it matches a shape
 * worth naming. Returns null for anything else — a half-truth about when a
 * schedule fires is worse than the raw cron plus the next-run preview.
 */
export function describeCron(expression: string): string | null {
  const [minute, hour, dom, month, dow] = splitCron(expression)
  if (month !== "*" || dom !== "*") return null
  if (minute === undefined || hour === undefined || dow === undefined) return null

  const at = describeTimeOfDay(minute, hour)
  if (!at) return null
  if (dow === "*") return `every day ${at}`
  if (dow === "MON-FRI") return `weekdays ${at}`
  if (dow === "SAT,SUN") return `weekends ${at}`
  if (/^[A-Z]{3}$/.test(dow)) return `${dow.charAt(0)}${dow.slice(1).toLowerCase()}days ${at}`
  return null
}

function describeTimeOfDay(minute: string, hour: string): string | null {
  if (hour === "*") {
    if (minute === "*") return "every minute"
    if (minute.startsWith("*/")) return `every ${minute.slice(2)}m`
    return `hourly at :${minute.padStart(2, "0")}`
  }
  if (hour.startsWith("*/") && minute === "0") return `every ${hour.slice(2)}h`
  if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) {
    return `at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
  }
  return null
}
