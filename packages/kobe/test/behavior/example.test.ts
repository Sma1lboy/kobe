/**
 * The canonical example behavior test.
 *
 * Goal: prove the harness end-to-end on the 0.1-scaffold binary.
 * If this test passes, the load-bearing claim of Stream 0.4 holds:
 *   "An agent can run `bun run test:behavior` and have it spawn the
 *   kobe binary, drive it with keystrokes, capture the visible
 *   screen, and assert on visible state."
 *
 * Every subsequent stream's behavior test should follow the same
 * shape: spawn → wait → assert → exit.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

afterEach(async () => {
  // Defensive: even if the test threw, we never want a zombie pty.
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

test("kobe boots and renders its title in the bordered box", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-example-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })

  kobe = await spawnKobe({
    env: {
      HOME: homeDir,
      KOBE_HOME_DIR: homeDir,
      KOBE_TEST_ENGINE: "fake",
    },
  })
  // Intentionally minimal — phase-specific banner text changes every
  // wave. The harness's job is to prove the binary booted, painted,
  // and is reachable. "kobe" appears in the title bar of every phase.
  const screen = await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
  expect(screen).toContain("KobeCode")
  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 20_000)
