import { describe, expect, test } from "vitest"
import { describeCron } from "../src/components/RoutinesPage.tsx"

describe("describeCron", () => {
  test("common shapes read as everyday language", () => {
    expect(describeCron("*/5 * * * *")).toBe("every 5 min")
    expect(describeCron("0 * * * *")).toBe("hourly at :00")
    expect(describeCron("0 9 * * *")).toBe("daily at 09:00")
    expect(describeCron("30 18 * * 1-5")).toBe("weekdays at 18:30")
    expect(describeCron("0 9 * * 1")).toBe("Mon at 09:00")
    expect(describeCron("0 9 * * 1,3,5")).toBe("Mon/Wed/Fri at 09:00")
    expect(describeCron("0 9 15 * *")).toBe("monthly on day 15 at 09:00")
  })

  test("unreadable shapes return null", () => {
    expect(describeCron("bogus")).toBeNull()
    expect(describeCron("0 9 * *")).toBeNull()
    expect(describeCron("*/5 2 * * 1-5")).toBeNull()
  })
})
