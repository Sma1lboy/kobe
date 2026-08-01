/**
 * Five-field cron parsing + occurrence search for daemon Automations.
 *
 * Hand-rolled on purpose: the repo has ZERO scheduling dependencies, and
 * `bun build --compile` bans native/N-API addons — a pure-JS parser sized to
 * five fields is smaller than auditing a package for that constraint.
 *
 * Two functions, both pure, both local-time (the daemon runs on the user's
 * machine; a timezone field is deliberately out of scope for v1):
 *
 *   - {@link nextCronAfter}       — advance a schedule after it fires
 *   - {@link latestCronAtOrBefore} — "what SHOULD have run by now", which is
 *     what missed-run compensation needs after the daemon was down
 *
 * Both scan minute-by-minute rather than solving the field constraints
 * algebraically. A valid expression can have a genuinely huge gap (`0 0 29 2 *`
 * skips 8 years across a non-leap century boundary), so the scan bound is
 * generous; the loop body is a handful of Set lookups, so even the pathological
 * case stays well under a millisecond.
 */

const MINUTE_MS = 60_000

/** Scan ceiling in minutes. Sized for `0 0 29 2 *` (Feb 29 across 2100). */
const SCAN_MINUTES = 9 * 366 * 24 * 60

export interface ParsedCron {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  /** True when the day-of-month field is anything but `*`. */
  readonly dayOfMonthRestricted: boolean
  /** True when the day-of-week field is anything but `*`. */
  readonly dayOfWeekRestricted: boolean
}

const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
  ["JAN", 1],
  ["FEB", 2],
  ["MAR", 3],
  ["APR", 4],
  ["MAY", 5],
  ["JUN", 6],
  ["JUL", 7],
  ["AUG", 8],
  ["SEP", 9],
  ["OCT", 10],
  ["NOV", 11],
  ["DEC", 12],
])

const DAY_NAMES: ReadonlyMap<string, number> = new Map([
  ["SUN", 0],
  ["MON", 1],
  ["TUE", 2],
  ["WED", 3],
  ["THU", 4],
  ["FRI", 5],
  ["SAT", 6],
])

/** Bound the accepted expression so a pathological string can't drive the parser. */
const MAX_EXPRESSION_LENGTH = 256

function fieldNumber(raw: string, names: ReadonlyMap<string, number> | undefined, field: string): number {
  const token = raw.toUpperCase()
  const named = names?.get(token)
  if (named !== undefined) return named
  // Number("") is 0 and Number(" 5 ") is 5 — neither is a valid cron token, so
  // require the literal digit form before trusting the coercion.
  if (!/^\d+$/.test(token)) throw new Error(`invalid cron ${field}: ${raw}`)
  return Number(token)
}

/**
 * One comma-separated field into the set of values it matches. Supports
 * a star, `N`, `A-B`, and a `/step` suffix on any of those (`10-30/5`).
 */
function parseField(args: {
  value: string
  min: number
  max: number
  field: string
  names?: ReadonlyMap<string, number>
  /** Day-of-week only: cron accepts 7 as Sunday alongside 0. */
  normalize?: (value: number) => number
}): Set<number> {
  const out = new Set<number>()
  for (const part of args.value.split(",")) {
    if (part.length === 0) throw new Error(`invalid cron ${args.field}: ${args.value}`)
    const [spec, stepRaw, ...extra] = part.split("/")
    if (extra.length > 0 || spec === undefined) throw new Error(`invalid cron ${args.field}: ${part}`)
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw new Error(`invalid cron ${args.field} step: ${part}`)
      step = Number(stepRaw)
      if (step < 1) throw new Error(`invalid cron ${args.field} step: ${part}`)
    }

    let lo: number
    let hi: number
    if (spec === "*") {
      lo = args.min
      hi = args.max
    } else if (spec.includes("-")) {
      const [loRaw, hiRaw, ...rest] = spec.split("-")
      if (rest.length > 0 || loRaw === undefined || hiRaw === undefined) {
        throw new Error(`invalid cron ${args.field} range: ${part}`)
      }
      lo = fieldNumber(loRaw, args.names, args.field)
      hi = fieldNumber(hiRaw, args.names, args.field)
    } else {
      lo = fieldNumber(spec, args.names, args.field)
      // A bare `N/step` means "from N to the field max", not just N.
      hi = stepRaw === undefined ? lo : args.max
    }

    if (lo < args.min || hi > args.max || lo > hi) {
      throw new Error(`cron ${args.field} out of range: ${part}`)
    }
    for (let v = lo; v <= hi; v += step) out.add(args.normalize ? args.normalize(v) : v)
  }
  return out
}

/** Parse a five-field expression. Throws with a human-readable reason. */
export function parseCron(expression: string): ParsedCron {
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error("cron expression is too long")
  const fields = expression.trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) {
    throw new Error(`cron expression needs 5 fields (minute hour day month weekday), got ${fields.length}`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  return {
    minutes: parseField({ value: minute, min: 0, max: 59, field: "minute" }),
    hours: parseField({ value: hour, min: 0, max: 23, field: "hour" }),
    daysOfMonth: parseField({ value: dayOfMonth, min: 1, max: 31, field: "day-of-month" }),
    months: parseField({ value: month, min: 1, max: 12, field: "month", names: MONTH_NAMES }),
    daysOfWeek: parseField({
      value: dayOfWeek,
      min: 0,
      max: 7,
      field: "weekday",
      names: DAY_NAMES,
      // 7 and 0 are both Sunday; fold so matching only ever tests 0-6.
      normalize: (v) => v % 7,
    }),
    dayOfMonthRestricted: dayOfMonth !== "*",
    dayOfWeekRestricted: dayOfWeek !== "*",
  }
}

/** True when `expression` parses. Used by CLI/RPC validation before persisting. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

/**
 * Does `timeMs` match? Day matching follows the Vixie-cron rule that trips
 * everyone up: when BOTH day fields are restricted they are OR'd, not AND'd
 * (`0 0 1 * MON` = the 1st **or** any Monday). With one restricted, only that
 * one applies; with neither, every day matches.
 */
export function cronMatches(rule: ParsedCron, timeMs: number): boolean {
  const d = new Date(timeMs)
  if (!rule.minutes.has(d.getMinutes())) return false
  if (!rule.hours.has(d.getHours())) return false
  if (!rule.months.has(d.getMonth() + 1)) return false

  const domMatch = rule.daysOfMonth.has(d.getDate())
  const dowMatch = rule.daysOfWeek.has(d.getDay())
  if (rule.dayOfMonthRestricted && rule.dayOfWeekRestricted) return domMatch || dowMatch
  if (rule.dayOfMonthRestricted) return domMatch
  if (rule.dayOfWeekRestricted) return dowMatch
  return true
}

/** Truncate to the start of the containing minute (cron's resolution).
 *  Epoch ms are UTC-anchored and every supported timezone offset is a whole
 *  number of minutes, so the modulo lands on a local minute boundary too. */
function floorToMinute(ms: number): number {
  return ms - (ms % MINUTE_MS)
}

/**
 * First occurrence strictly AFTER `afterMs`.
 *
 * Strictly-after matters: this is called right after a run fires, and a
 * `<=` boundary would return the timestamp that just fired and spin the
 * runner. Throws when no occurrence exists within the scan bound — a
 * schedule that parses but never fires (`0 0 30 2 *`) is a user error worth
 * surfacing at create time, not a silent no-op.
 */
export function nextCronAfter(expression: string, afterMs: number): number {
  const rule = parseCron(expression)
  let candidate = floorToMinute(afterMs) + MINUTE_MS
  for (let i = 0; i < SCAN_MINUTES; i++) {
    if (cronMatches(rule, candidate)) return candidate
    candidate += MINUTE_MS
  }
  throw new Error(`cron expression never matches: ${expression}`)
}

/**
 * Latest occurrence at or before `nowMs`, searching back no further than
 * `notBeforeMs`; `null` when none exists in that window.
 *
 * This is the missed-run question: after the daemon was down, "what should
 * have run?" is NOT the same as "when is the next run" — the answer has to
 * look backwards. `notBeforeMs` bounds the walk (callers pass the schedule's
 * creation time, so a brand-new automation can't claim occurrences that
 * predate it).
 */
export function latestCronAtOrBefore(expression: string, nowMs: number, notBeforeMs: number): number | null {
  if (nowMs < notBeforeMs) return null
  const rule = parseCron(expression)
  let candidate = floorToMinute(nowMs)
  for (let i = 0; i < SCAN_MINUTES && candidate >= notBeforeMs; i++) {
    if (cronMatches(rule, candidate)) return candidate
    candidate -= MINUTE_MS
  }
  return null
}
