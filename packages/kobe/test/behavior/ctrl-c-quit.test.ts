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

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = null
})

async function spawnIsolatedKobe(): Promise<KobeHandle> {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-ctrl-c-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  return await spawnKobe({
    env: {
      HOME: homeDir,
      KOBE_HOME_DIR: homeDir,
      KOBE_TEST_ENGINE: "fake",
    },
  })
}

test("a single Ctrl+C does not exit kobe and arms the quit hint", async () => {
  kobe = await spawnIsolatedKobe()
  await kobe.waitFor((s) => s.includes("KobeCode") || s.includes("kobe"), 10_000)

  // \x03 = Ctrl+C. First press must not kill the process.
  await kobe.sendKeys("\x03")

  // Wait for the hint chip to appear in the status bar. The exact copy
  // is owned by `useKobeKeybindings`'s StatusBar wiring (app.tsx). On
  // narrow PTYs the trailing "to exit" can clip — the prefix is the
  // load-bearing part for a behavioral assertion.
  const screen = await kobe.waitFor((s) => s.includes("again") && s.includes("exit"), 5_000)
  expect(screen).toContain("again")
  expect(kobe.closed).toBe(false)
}, 30_000)

test("two Ctrl+C presses within the quit window exit kobe", async () => {
  kobe = await spawnIsolatedKobe()
  await kobe.waitFor((s) => s.includes("KobeCode") || s.includes("kobe"), 10_000)

  // First Ctrl+C arms; wait for the hint so we know the handler ran
  // (otherwise a back-to-back send can race the renderer's keypress
  // dispatch on a cold boot).
  await kobe.sendKeys("\x03")
  await kobe.waitFor((s) => s.includes("again") && s.includes("exit"), 5_000)

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

test("double Ctrl+C exit cleans up the terminal (mouse tracking off, alt-screen restored)", async () => {
  // Regression for the screenshot Jackson sent on 2026-05-10: after
  // Ctrl+C×2, the host shell was being flooded with `\x1b[<...M` SGR
  // mouse events because the previous default `onQuit = process.exit(0)`
  // bypassed every opentui exit hook. The fix calls renderer.destroy()
  // first, which writes the disable sequences synchronously through the
  // native renderer before the process is killed.
  kobe = await spawnIsolatedKobe()
  await kobe.waitFor((s) => s.includes("KobeCode") || s.includes("kobe"), 10_000)

  await kobe.sendKeys("\x03")
  await kobe.waitFor((s) => s.includes("again") && s.includes("exit"), 5_000)
  await kobe.sendKeys("\x03")

  const deadline = Date.now() + 5_000
  while (!kobe.closed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(kobe.closed).toBe(true)

  // After exit, the raw byte buffer should contain at least one of the
  // mouse-tracking-disable sequences opentui emits on teardown:
  //   \x1b[?1003l  any-event mouse off
  //   \x1b[?1006l  SGR extended mouse off
  //   \x1b[?1015l  urxvt-style mouse off
  //   \x1b[?1000l  basic mouse off
  // Any of them proves cleanup ran. Without renderer.destroy(), NONE
  // of these sequences would be emitted.
  const raw = kobe.captureRaw()
  // Build the mouse-disable matcher from a string (avoids biome's
  // noControlCharactersInRegex rule — ESC is intrinsic to ANSI matching
  // here). \x1b followed by `[?` then any of the four mouse-mode codes
  // followed by `l` (lowercase = disable).
  const ESC = String.fromCharCode(0x1b)
  const mouseDisable = new RegExp(`${ESC}\\[\\?(1000|1003|1006|1015)l`)
  expect(raw).toMatch(mouseDisable)

  // And alt-screen restored (`\x1b[?1049l`) — the user's host shell
  // should be back, not stuck looking at TUI residue.
  expect(raw).toContain(`${ESC}[?1049l`)
}, 30_000)
