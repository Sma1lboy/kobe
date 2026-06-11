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

// Why this matters: the rail's filter state lives at module level precisely so
// it SURVIVES the AppShell remount on the first `/` → /task/$taskId navigation
// (issue #7). These tests lock the store's semantics — especially the
// rising-edge pref sync, which is what keeps a remount from stomping a local
// sort toggle the way the old useState + mount-effect did.

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
