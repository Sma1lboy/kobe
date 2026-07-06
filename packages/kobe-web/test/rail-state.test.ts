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
    // A remount re-reads the module state — nothing resets.
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
      applyPrefSort("recent") // TUI pref arrives
      setRailSortMode("default") // user toggles locally in the web rail
      applyPrefSort("recent") // AppShell remounts, effect replays same pref
      expect(getRailState().sortMode).toBe("default")
    })

    it("a genuinely CHANGED pref overrides the local toggle", () => {
      applyPrefSort("recent")
      setRailSortMode("default")
      applyPrefSort("recent") // replay: ignored
      resetRailState()
      applyPrefSort("default") // fresh edge after reset
      setRailSortMode("recent")
      applyPrefSort("recent") // pref CHANGED default→recent: applies
      expect(getRailState().sortMode).toBe("recent")
    })
  })
})
