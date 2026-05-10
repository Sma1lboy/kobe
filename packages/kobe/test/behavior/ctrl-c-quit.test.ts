/**
 * Behavior test for the Ctrl+C double-tap quit contract.
 *
 * Jackson's spec: a single Ctrl+C must NOT exit kobe. The first press
 * arms a quit (showing a "Press Ctrl+C again to exit" hint in the
 * status bar); a second Ctrl+C within ~1.5s actually quits. If the
 * renderer has a text selection, Ctrl+C copies it instead of arming
 * (terminal-style copy behavior). Pre-fix, opentui's default
 * `exitOnCtrlC: true` killed the process on the first press.
 *
 * We exercise the two key paths:
 *   1. Single Ctrl+C → process stays alive; status bar shows the hint.
 *   2. Double Ctrl+C → process exits cleanly.
 *
 * The selection-copy path needs a mouse drag we can't drive from a PTY,
 * so it's covered by the unit-test surface (the handler logic) rather
 * than here. The behavioral guarantee tests own here is "Ctrl+C does
 * not kill kobe on first press" — that is the regression Jackson hit.
 */

import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
})

test("a single Ctrl+C does not exit kobe and arms the quit hint", async () => {
  kobe = await spawnKobe()
  await kobe.waitFor((s) => s.includes("KobeCode") || s.includes("kobe"), 10_000)

  // \x03 = Ctrl+C. First press must not kill the process.
  await kobe.sendKeys("\x03")

  // Wait for the hint chip to appear in the status bar. The exact copy
  // is owned by `useKobeKeybindings`'s StatusBar wiring (app.tsx). On
  // narrow PTYs the trailing "to exit" can clip — the prefix is the
  // load-bearing part for a behavioral assertion.
  const screen = await kobe.waitFor((s) => s.includes("Ctrl+C again"), 5_000)
  expect(screen).toContain("Ctrl+C again")
  expect(kobe.closed).toBe(false)
}, 30_000)

test("two Ctrl+C presses within the quit window exit kobe", async () => {
  kobe = await spawnKobe()
  await kobe.waitFor((s) => s.includes("KobeCode") || s.includes("kobe"), 10_000)

  // First Ctrl+C arms; wait for the hint so we know the handler ran
  // (otherwise a back-to-back send can race the renderer's keypress
  // dispatch on a cold boot).
  await kobe.sendKeys("\x03")
  await kobe.waitFor((s) => s.includes("Ctrl+C again"), 5_000)

  // Second Ctrl+C inside the 1500ms quit window → process.exit(0).
  await kobe.sendKeys("\x03")

  // Poll for the pty closure rather than asserting immediately —
  // process.exit is queued via process.nextTick on opentui's renderer
  // teardown path.
  const deadline = Date.now() + 5_000
  while (!kobe.closed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(kobe.closed).toBe(true)
}, 30_000)
