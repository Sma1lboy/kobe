/**
 * The arbitration core (activity-arbitrate.ts) — herdr's multi-source model
 * pinned branch by branch. Every status source writes its own slot; this
 * pure function is the ONE place the priority order lives:
 *
 *   sticky hook > hook (unless a fresher observed rest corrects a stale
 *   hook running) > observed (fills holes / known-idle) > unknown.
 *
 * Registry-level parity (watchdogs, replay, wire payloads) is pinned by
 * activity-state / activity-liveness / activity-observer tests; this file
 * pins the arbitration rules themselves so a future source addition changes
 * ONE table of expectations.
 */

import { recomputeTabActivity } from "@sma1lboy/kobe-daemon/daemon/activity-arbitrate"
import { describe, expect, it } from "vitest"

const T = 1_000_000

describe("recomputeTabActivity", () => {
  it("no slots at all ⇒ unknown (undefined), distinguishable from known-idle", () => {
    expect(recomputeTabActivity({}, T)).toBeUndefined()
  })

  it("observed running fills the hole when no hook ever reported (#16 restart seeding)", () => {
    const eff = recomputeTabActivity({ observed: { state: "running", at: T } }, T)
    expect(eff).toMatchObject({ state: "running", source: "observed" })
  })

  it("observed idle alone is the KNOWN-idle marker", () => {
    const eff = recomputeTabActivity({ observed: { state: "idle", at: T } }, T)
    expect(eff).toMatchObject({ state: "idle", source: "observed" })
  })

  it("a hook entry in ANY non-running state beats observation outright", () => {
    for (const state of ["turn_complete", "permission_needed", "error", "rate_limited"] as const) {
      const eff = recomputeTabActivity(
        { hook: { state, at: T - 60_000 }, observed: { state: "idle", at: T } },
        T,
        0, // age gate fully open — sticky still wins
      )
      expect(eff).toMatchObject({ state, source: "hook" })
    }
  })

  it("a hook running beats an observed WORKING claim (hook is authoritative)", () => {
    const eff = recomputeTabActivity(
      { hook: { state: "running", at: T - 100 }, observed: { state: "running", at: T } },
      T,
      0,
    )
    expect(eff).toMatchObject({ state: "running", source: "hook" })
  })

  it("a YOUNG hook running stands against an observed rest (turn-boundary grace)", () => {
    const eff = recomputeTabActivity(
      { hook: { state: "running", at: T - 5_000 }, observed: { state: "idle", at: T } },
      T,
      20_000,
    )
    expect(eff).toMatchObject({ state: "running", source: "hook" })
  })

  it("a STALE hook running is corrected by a fresher observed rest (ESC / dead engine)", () => {
    const eff = recomputeTabActivity(
      {
        hook: { state: "running", at: T - 60_000, vendor: "claude", session: { id: "s1" } },
        observed: { state: "idle", at: T - 1_000 },
      },
      T,
      20_000,
    )
    // …and the correction inherits the hook's lineage (which engine this was).
    expect(eff).toMatchObject({ state: "idle", source: "observed", vendor: "claude", session: { id: "s1" } })
  })

  it("freshness guard: an observation OLDER than the hook claim never corrects it", () => {
    // herdr's fallback_not_older_than_hook — a stale observer pass must not
    // idle a turn that started after the evidence was gathered, no matter
    // how old the claim is.
    const eff = recomputeTabActivity(
      { hook: { state: "running", at: T - 60_000 }, observed: { state: "idle", at: T - 120_000 } },
      T,
      20_000,
    )
    expect(eff).toMatchObject({ state: "running", source: "hook" })
  })

  it("default gate (Infinity) means observation NEVER corrects a hook claim", () => {
    const eff = recomputeTabActivity(
      { hook: { state: "running", at: T - 3_600_000 }, observed: { state: "idle", at: T } },
      T,
    )
    expect(eff).toMatchObject({ state: "running", source: "hook" })
  })

  it("hook detail rides the effective payload (badge subtitles read it)", () => {
    const eff = recomputeTabActivity(
      { hook: { state: "permission_needed", at: T, detail: { waiting: "permission" } } },
      T,
    )
    expect(eff?.detail).toEqual({ waiting: "permission" })
  })
})
