import { describe, expect, it } from "vitest"
import {
  cronMatches,
  isValidCron,
  latestCronAtOrBefore,
  nextCronAfter,
  parseCron,
} from "../../../kobe-daemon/src/daemon/cron.ts"

/** Local-time helper — the parser is local-time by design, so tests must be too. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

function iso(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe("parseCron", () => {
  it("rejects anything but five fields", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/)
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/)
    expect(() => parseCron("")).toThrow(/5 fields/)
  })

  it("rejects out-of-range and malformed tokens", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/)
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/)
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/)
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/)
    expect(() => parseCron("30-10 * * * *")).toThrow(/out of range/)
    expect(() => parseCron("abc * * * *")).toThrow(/invalid cron minute/)
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/)
  })

  it("accepts names, ranges, lists, and steps", () => {
    expect(isValidCron("0 9 * * MON-FRI")).toBe(true)
    expect(isValidCron("*/15 * * * *")).toBe(true)
    expect(isValidCron("0 0 1 JAN,JUL *")).toBe(true)
    expect(isValidCron("30 9-17/4 * * *")).toBe(true)
  })

  it("treats weekday 7 and 0 as the same Sunday", () => {
    const zero = parseCron("0 0 * * 0")
    const seven = parseCron("0 0 * * 7")
    // 2026-08-02 is a Sunday.
    expect(cronMatches(zero, at(2026, 8, 2))).toBe(true)
    expect(cronMatches(seven, at(2026, 8, 2))).toBe(true)
  })

  it("expands a bare N/step from N to the field max", () => {
    const rule = parseCron("5/20 * * * *")
    expect([...rule.minutes].sort((a, b) => a - b)).toEqual([5, 25, 45])
  })
})

describe("cronMatches day-field OR rule", () => {
  // Vixie cron: when BOTH day fields are restricted they are OR'd, not AND'd.
  const rule = parseCron("0 0 1 * MON")

  it("matches the day-of-month even on the wrong weekday", () => {
    // 2026-09-01 is a Tuesday.
    expect(cronMatches(rule, at(2026, 9, 1))).toBe(true)
  })

  it("matches the weekday even on the wrong day-of-month", () => {
    // 2026-09-07 is a Monday.
    expect(cronMatches(rule, at(2026, 9, 7))).toBe(true)
  })

  it("rejects a day that satisfies neither", () => {
    // 2026-09-02, a Wednesday.
    expect(cronMatches(rule, at(2026, 9, 2))).toBe(false)
  })

  it("ANDs nothing when only one day field is restricted", () => {
    const domOnly = parseCron("0 0 15 * *")
    expect(cronMatches(domOnly, at(2026, 9, 15))).toBe(true)
    expect(cronMatches(domOnly, at(2026, 9, 16))).toBe(false)
  })
})

describe("nextCronAfter", () => {
  it("is strictly after — a matching instant does not return itself", () => {
    // Without strict-after the runner would re-fire the timestamp it just ran.
    const now = at(2026, 7, 31, 9, 0)
    expect(nextCronAfter("0 9 * * *", now)).toBe(at(2026, 8, 1, 9, 0))
  })

  it("ignores sub-minute precision in the input", () => {
    const noisy = at(2026, 7, 31, 8, 59) + 45_123
    expect(nextCronAfter("0 9 * * *", noisy)).toBe(at(2026, 7, 31, 9, 0))
  })

  it("walks every-N-minutes schedules", () => {
    expect(nextCronAfter("*/15 * * * *", at(2026, 7, 31, 10, 7))).toBe(at(2026, 7, 31, 10, 15))
    expect(nextCronAfter("*/15 * * * *", at(2026, 7, 31, 10, 45))).toBe(at(2026, 7, 31, 11, 0))
  })

  it("skips to Monday for a weekday schedule run on Friday evening", () => {
    // 2026-07-31 is a Friday; next weekday 09:00 is Monday 2026-08-03.
    expect(nextCronAfter("0 9 * * MON-FRI", at(2026, 7, 31, 18, 0))).toBe(at(2026, 8, 3, 9, 0))
  })

  it("crosses a month end", () => {
    expect(nextCronAfter("0 0 1 * *", at(2026, 7, 31, 23, 59))).toBe(at(2026, 8, 1, 0, 0))
  })

  it("crosses a year end", () => {
    expect(nextCronAfter("0 0 1 1 *", at(2026, 12, 31, 12, 0))).toBe(at(2027, 1, 1, 0, 0))
  })

  it("finds the next Feb 29 across the scan window", () => {
    // 2028 is the next leap year after 2026.
    expect(iso(nextCronAfter("0 0 29 2 *", at(2026, 3, 1)))).toBe("2028-02-29 00:00")
  })

  it("skips a day-of-month that does not exist in short months", () => {
    // Feb has no 31st, so a `31st` schedule jumps Feb entirely.
    expect(iso(nextCronAfter("0 0 31 * *", at(2026, 1, 31, 1, 0)))).toBe("2026-03-31 00:00")
  })

  it("throws for an expression that parses but never fires", () => {
    expect(() => nextCronAfter("0 0 30 2 *", at(2026, 1, 1))).toThrow(/never matches/)
  })
})

describe("latestCronAtOrBefore", () => {
  const CREATED = at(2026, 1, 1)

  it("returns the matching instant itself (at-or-before, unlike nextCronAfter)", () => {
    const now = at(2026, 7, 31, 9, 0)
    expect(latestCronAtOrBefore("0 9 * * *", now, CREATED)).toBe(now)
  })

  it("looks backwards past a daemon downtime", () => {
    // Daemon was down; it is now 14:30 and 09:00 today was missed.
    expect(latestCronAtOrBefore("0 9 * * *", at(2026, 7, 31, 14, 30), CREATED)).toBe(at(2026, 7, 31, 9, 0))
  })

  it("returns only the MOST RECENT occurrence, not every missed one", () => {
    // Three days down: the compensation policy is "run once", so the answer is
    // the newest occurrence — the runner never sees the older two.
    expect(latestCronAtOrBefore("0 9 * * *", at(2026, 7, 31, 10, 0), CREATED)).toBe(at(2026, 7, 31, 9, 0))
  })

  it("will not reach back before the notBefore bound", () => {
    const created = at(2026, 7, 31, 12, 0)
    expect(latestCronAtOrBefore("0 9 * * *", at(2026, 7, 31, 14, 0), created)).toBeNull()
  })

  it("returns null when now precedes the bound entirely", () => {
    expect(latestCronAtOrBefore("* * * * *", at(2026, 1, 1), at(2026, 6, 1))).toBeNull()
  })

  it("crosses a weekend backwards for a weekday schedule", () => {
    // 2026-08-02 is a Sunday; the last weekday 09:00 was Friday 2026-07-31.
    expect(latestCronAtOrBefore("0 9 * * MON-FRI", at(2026, 8, 2, 20, 0), CREATED)).toBe(at(2026, 7, 31, 9, 0))
  })
})

describe("nextCronAfter / latestCronAtOrBefore agree", () => {
  it("round-trips: the next occurrence's own latest-at-or-before is itself", () => {
    const start = at(2026, 7, 31, 3, 17)
    for (const expr of ["*/15 * * * *", "0 9 * * MON-FRI", "0 0 1 * *", "30 6 * * SUN"]) {
      const next = nextCronAfter(expr, start)
      expect(latestCronAtOrBefore(expr, next, start)).toBe(next)
    }
  })
})
