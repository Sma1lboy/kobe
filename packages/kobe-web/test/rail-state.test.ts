import { beforeEach, describe, expect, it } from "vitest"
import {
  applyPrefSort,
  getRailState,
  resetRailState,
  setRailQuery,
  setRailShowArchived,
  setRailSortMode,
  setRailStatusFilter,
} from "../src/lib/rail-state.ts"


beforeEach(() => {
  resetRailState()
})

describe("rail-state store", () => {
  it("starts pristine", () => {
    expect(getRailState()).toEqual({
      query: "",
      statusFilter: "all",
      sortMode: "default",
      showArchived: false,
    })
  })

  it("holds each field across reads (the remount-survival contract)", () => {
    setRailQuery("auth")
    setRailStatusFilter("attention")
    setRailSortMode("recent")
    setRailShowArchived(true)
    expect(getRailState()).toEqual({
      query: "auth",
      statusFilter: "attention",
      sortMode: "recent",
      showArchived: true,
    })
  })

  describe("applyPrefSort (TUI ui-prefs sync, rising edge)", () => {
    it("applies a pref the first time it's seen", () => {
      applyPrefSort("recent")
      expect(getRailState().sortMode).toBe("recent")
    })

    it("ignores undefined (no prefs yet)", () => {
      setRailSortMode("recent")
      applyPrefSort(undefined)
      expect(getRailState().sortMode).toBe("recent")
    })

    it("does NOT re-stomp a local toggle when a remount replays the same pref", () => {
      applyPrefSort("recent")
      setRailSortMode("default")
      applyPrefSort("recent")
      expect(getRailState().sortMode).toBe("default")
    })

    it("a genuinely CHANGED pref overrides the local toggle", () => {
      applyPrefSort("recent")
      setRailSortMode("default")
      applyPrefSort("recent")
      resetRailState()
      applyPrefSort("default")
      setRailSortMode("recent")
      applyPrefSort("recent")
      expect(getRailState().sortMode).toBe("recent")
    })
  })
})
