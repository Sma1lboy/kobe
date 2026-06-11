import { describe, expect, it } from "vitest"
import { activityColor, activityLabel } from "../src/lib/activity.ts"
import type { ActivityState } from "../src/lib/types.ts"

/**
 * activityColor/activityLabel are the SHARED engine-activity presentation used
 * by both the task rail (AppShell) and the Overview triage view, so the two
 * never drift. Lock the dot color + human label for every known state, and the
 * neutral fallback for unknown/undefined, so a renamed engine state can't
 * silently render a blank dot in one surface and a colored one in the other.
 */

const KNOWN: ActivityState[] = [
  "running",
  "waiting_permission",
  "rate_limited",
  "error",
  "idle",
]

describe("activityColor", () => {
  it("maps each known state to its dot color", () => {
    expect(activityColor("running")).toBe("bg-kobe-orange")
    expect(activityColor("waiting_permission")).toBe("bg-kobe-blue")
    expect(activityColor("rate_limited")).toBe("bg-kobe-yellow")
    expect(activityColor("error")).toBe("bg-kobe-red")
    expect(activityColor("idle")).toBe("bg-kobe-green/60")
  })

  it("falls back to the neutral dot for undefined", () => {
    expect(activityColor(undefined)).toBe("bg-subtle")
  })

  it("falls back to the neutral dot for an unknown state string", () => {
    expect(activityColor("compacting")).toBe("bg-subtle")
  })

  it("never returns an empty class for a known state", () => {
    for (const s of KNOWN) expect(activityColor(s)).not.toBe("")
  })
})

describe("activityLabel", () => {
  it("maps each known state to its human label", () => {
    expect(activityLabel("running")).toBe("running")
    expect(activityLabel("waiting_permission")).toBe("needs input")
    expect(activityLabel("rate_limited")).toBe("rate limited")
    expect(activityLabel("error")).toBe("error")
    expect(activityLabel("idle")).toBe("idle")
  })

  it("returns an empty label for undefined (no chip text)", () => {
    expect(activityLabel(undefined)).toBe("")
  })

  it("returns an empty label for an unknown state string", () => {
    expect(activityLabel("compacting")).toBe("")
  })
})
