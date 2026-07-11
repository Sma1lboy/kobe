/**
 * Regression pin: the pure-TUI host owns the outer terminal tab title while
 * it is running. Packaged kobe previously emitted no OSC title, so iTerm2
 * fell back to the JavaScript runtime name (observed as "node").
 */

import { spawn } from "node-pty"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, DIST_CLI, makeBehaviorEnv } from "./harness.ts"

const TITLE_SEQUENCE = "\x1b]0;kobe\x07"

describe("kobe outer terminal title (behavior)", () => {
  let env: BehaviorEnv

  beforeAll(async () => {
    env = await makeBehaviorEnv()
  })

  afterAll(async () => {
    await env.dispose()
  })

  it("publishes kobe as the terminal title on pure-TUI boot", async () => {
    const child = spawn("bun", [DIST_CLI], {
      cols: 120,
      rows: 35,
      cwd: env.home,
      env: { ...env.env, KOBE_TUI: "1" } as Record<string, string>,
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
