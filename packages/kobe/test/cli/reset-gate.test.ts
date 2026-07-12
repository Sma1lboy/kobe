/**
 * Breaking-version reset gate — the pure decision layer. These pin the
 * contract the boot block and `kobe update`'s warning both rely on: a
 * launch is blocked exactly when the last-run stamp and the running
 * version sit on opposite sides of a BREAKING_VERSIONS entry, in either
 * direction. Wrong here = users bypass a required reset (state corruption)
 * or get walled off after a harmless patch (trust erosion).
 */

import { describe, expect, test } from "vitest"
import { resetGateBlockers } from "../../src/cli/reset-gate.ts"
import { breakingVersionsCrossed } from "../../src/version.ts"

const BREAKING = ["0.8.0", "0.9.5"]

describe("breakingVersionsCrossed", () => {
  test("an upgrade across one breaking version reports it", () => {
    expect(breakingVersionsCrossed("0.7.99", "0.8.2", BREAKING)).toEqual(["0.8.0"])
  })

  test("a jump across several reports all of them", () => {
    expect(breakingVersionsCrossed("0.7.0", "1.0.0", BREAKING)).toEqual(["0.8.0", "0.9.5"])
  })

  test("moving TO the breaking version itself counts (boundary is inclusive on the high side)", () => {
    expect(breakingVersionsCrossed("0.7.99", "0.8.0", BREAKING)).toEqual(["0.8.0"])
  })

  test("moving within one side crosses nothing", () => {
    expect(breakingVersionsCrossed("0.8.0", "0.9.4", BREAKING)).toEqual([])
    expect(breakingVersionsCrossed("0.7.1", "0.7.99", BREAKING)).toEqual([])
  })

  test("a downgrade back across a breaking version also reports it", () => {
    expect(breakingVersionsCrossed("0.8.2", "0.7.99", BREAKING)).toEqual(["0.8.0"])
  })

  test("same-version moves cross nothing", () => {
    expect(breakingVersionsCrossed("0.8.0", "0.8.0", BREAKING)).toEqual([])
  })
})

describe("resetGateBlockers", () => {
  test("blocks when the stamp is on the far side of a breaking version", () => {
    expect(resetGateBlockers("0.7.99", "0.8.1", BREAKING)).toEqual(["0.8.0"])
  })

  test("a missing or malformed stamp never blocks (fresh install / pre-gate state)", () => {
    expect(resetGateBlockers(undefined, "0.8.1", BREAKING)).toEqual([])
    expect(resetGateBlockers("", "0.8.1", BREAKING)).toEqual([])
    expect(resetGateBlockers(42, "0.8.1", BREAKING)).toEqual([])
  })

  test("a stamp on the same side passes", () => {
    expect(resetGateBlockers("0.8.0", "0.8.3", BREAKING)).toEqual([])
  })

  test("a downgraded binary is blocked the same way", () => {
    expect(resetGateBlockers("0.8.1", "0.7.99", BREAKING)).toEqual(["0.8.0"])
  })
})
