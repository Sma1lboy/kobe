import { describe, expect, test } from "vitest"
import {
  COMPOSER_FIELDS,
  type ComposerDraft,
  canSubmitDraft,
  firstIncompleteField,
  nextComposerField,
  previewSchedule,
} from "../../src/tui/component/automation-composer"

const FULL: ComposerDraft = {
  name: "weekday audit",
  repo: "/x/kobe",
  prompt: "Audit dependencies.",
  schedule: "0 9 * * MON-FRI",
}

/** Fri 2026-07-31 10:00 local — the reference "now" for every preview test. */
const NOW = new Date(2026, 6, 31, 10, 0, 0).getTime()

describe("field order", () => {
  test("tab walks the card and wraps", () => {
    expect(nextComposerField("name")).toBe("repo")
    expect(nextComposerField("schedule")).toBe("confirm")
    expect(nextComposerField("confirm")).toBe("name")
  })

  test("shift-tab walks backwards and wraps", () => {
    expect(nextComposerField("repo", -1)).toBe("name")
    expect(nextComposerField("name", -1)).toBe("confirm")
  })

  test("an unknown field lands on the first one rather than nowhere", () => {
    expect(nextComposerField("bogus" as never)).toBe("name")
  })

  test("every field is reachable by tabbing once around", () => {
    const seen = new Set<string>()
    let field = COMPOSER_FIELDS[0] as (typeof COMPOSER_FIELDS)[number]
    for (let i = 0; i < COMPOSER_FIELDS.length; i++) {
      seen.add(field)
      field = nextComposerField(field)
    }
    expect(seen.size).toBe(COMPOSER_FIELDS.length)
  })
})

describe("validation", () => {
  test("a complete draft submits", () => {
    expect(canSubmitDraft(FULL)).toBe(true)
    expect(firstIncompleteField(FULL)).toBeNull()
  })

  test.each([
    ["name", { ...FULL, name: "  " }],
    ["repo", { ...FULL, repo: "" }],
    ["prompt", { ...FULL, prompt: "" }],
  ])("a blank %s blocks submit and is where focus goes", (field, draft) => {
    expect(canSubmitDraft(draft)).toBe(false)
    expect(firstIncompleteField(draft)).toBe(field)
  })

  test("an unparseable cron blocks submit", () => {
    const draft = { ...FULL, schedule: "not a cron" }
    expect(canSubmitDraft(draft)).toBe(false)
    expect(firstIncompleteField(draft)).toBe("schedule")
  })

  test("reports the FIRST gap, so tabbing forward fills them in order", () => {
    expect(firstIncompleteField({ name: "", repo: "", prompt: "", schedule: "nope" })).toBe("name")
  })
})

describe("previewSchedule", () => {
  test("rejects an unparseable expression", () => {
    expect(previewSchedule("every tuesday", NOW).kind).toBe("invalid")
    expect(previewSchedule("* * * *", NOW).kind).toBe("invalid")
  })

  test("flags a cron that parses but never fires", () => {
    // Feb 30 is syntactically fine and completely useless — the one class of
    // typo that looks correct right up until it silently never runs.
    expect(previewSchedule("0 0 30 2 *", NOW).kind).toBe("never")
  })

  test("shows a same-day fire as a bare wall-clock time", () => {
    const preview = previewSchedule("0 14 * * *", NOW)
    expect(preview).toMatchObject({ kind: "ok", relative: "in 4h", absolute: "14:00" })
  })

  test("names the weekday once it is not today", () => {
    // 10:00 Friday; the next weekday 09:00 is Monday.
    const preview = previewSchedule("0 9 * * MON-FRI", NOW)
    expect(preview).toMatchObject({ kind: "ok", absolute: "Mon 09:00" })
  })

  test("adds the date once it is more than a week out", () => {
    // Next Feb 1 from July is far enough that "Sun 00:00" would be ambiguous.
    const preview = previewSchedule("0 0 1 2 *", NOW)
    if (preview.kind !== "ok") throw new Error("expected a schedule")
    expect(preview.absolute).toContain("Feb 1")
  })

  test("relative time is phrased at the coarsest useful unit", () => {
    expect(previewSchedule("*/15 * * * *", NOW)).toMatchObject({ relative: "in 15m" })
    expect(previewSchedule("0 9 * * *", NOW)).toMatchObject({ relative: "in 23h" })
  })

  test("the preview's own timestamp is the time it claims", () => {
    // Guards the two formatters drifting from the timestamp they describe.
    const preview = previewSchedule("0 9 * * *", NOW)
    if (preview.kind !== "ok") throw new Error("expected a schedule")
    const at = new Date(preview.nextRunMs)
    expect(at.getHours()).toBe(9)
    expect(preview.nextRunMs).toBeGreaterThan(NOW)
  })
})
