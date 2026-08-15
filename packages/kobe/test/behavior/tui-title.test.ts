/**
 * Regression pin: the pure-TUI host owns the outer terminal tab title while
 * it is running. Packaged Rove previously emitted no OSC title, so iTerm2
 * fell back to the JavaScript runtime name (observed as "node").
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, DIST_ROVE_CLI, loadNodePty, makeBehaviorEnv } from "./harness.ts"

// node-pty is a native addon; CI's linux runner has no prebuild for it, so a
// top-level import fails the whole suite before skip logic can run. The
// shared loader also verifies it can actually SPAWN here (a sandboxed shell
// can have the module and still be denied posix_spawnp) — see harness.ts.
const nodePty = await loadNodePty()

const TITLE_SEQUENCE = "\x1b]0;rove\x07"

describe.skipIf(!nodePty)("Rove outer terminal title (behavior)", () => {
  let env: BehaviorEnv

  beforeAll(async () => {
    env = await makeBehaviorEnv()
  })

  afterAll(async () => {
    await env.dispose()
  })

  it("publishes rove as the terminal title on pure-TUI boot", async () => {
    if (!nodePty) throw new Error("unreachable: suite is skipped without node-pty")
    const child = nodePty.spawn("bun", [DIST_ROVE_CLI], {
      cols: 120,
      rows: 35,
      cwd: env.home,
      env: env.env as Record<string, string>,
    })
    let raw = ""
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`title sequence not observed; output-start=${JSON.stringify(raw.slice(0, 500))}`)),
          10_000,
        )
        const data = child.onData((chunk) => {
          raw += chunk
          if (!raw.includes(TITLE_SEQUENCE)) return
          clearTimeout(timeout)
          data.dispose()
          resolve()
        })
      })
      expect(raw).toContain(TITLE_SEQUENCE)
    } finally {
      child.kill()
    }
  }, 15_000)
})
