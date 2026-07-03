/**
 * `kobe doctor` black-box behavior — the DIST build, piped, fresh home.
 *
 * Why this exists: doctor/update-class regressions kept shipping with green
 * unit tests because the failures lived in the environment (packaged-vs-dev
 * paths, PATH state, TTY-vs-pipe), which mocks faked away. This suite runs
 * the real CLI against a real (temp) environment and asserts the visible
 * surface: exit codes + the report lines a bug reporter would paste.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, makeBehaviorEnv, runKobe } from "./harness.ts"

describe("kobe doctor (behavior)", () => {
  let env: BehaviorEnv
  beforeAll(async () => {
    env = await makeBehaviorEnv()
  })
  afterAll(async () => {
    await env.dispose()
  })

  it("reports build, terminal, daemon and state sections on a fresh home, exit 0", () => {
    const r = runKobe(["doctor"], env)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("kobe doctor")
    // Build line proves the packaged (dist) identity + platform got reported.
    expect(r.stdout).toMatch(/build: {2}v\d+\.\d+\.\d+ \(/)
    // Terminal section is the #192 triage surface.
    expect(r.stdout).toContain("terminal: TERM=")
    expect(r.stdout).toContain("running inside tmux:")
    // Piped run (no TTY) must SKIP the kitty probe instead of hanging or
    // leaking escape bytes into the pipe.
    expect(r.stdout).toContain("kitty keyboard protocol: skipped")
    expect(r.stdout).not.toContain("\x1b[?u")
    // Fresh home: no daemon, and the state files section still renders.
    expect(r.stdout).toContain("daemon:")
    expect(r.stdout).toContain("not running")
    expect(r.stdout).toContain("tasks.json:")
  })

  it("home/socket lines point INSIDE the temp KOBE_HOME (env isolation is real)", () => {
    const r = runKobe(["doctor"], env)
    expect(r.stdout).toContain(env.home)
    expect(r.stdout).not.toContain(`${process.env.HOME}/.kobe/daemon.sock`)
  })

  it("rejects unexpected arguments with usage on stderr, exit 2", () => {
    const r = runKobe(["doctor", "--bogus"], env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("unexpected argument")
    expect(r.stderr).toContain("Usage: kobe doctor")
  })
})
