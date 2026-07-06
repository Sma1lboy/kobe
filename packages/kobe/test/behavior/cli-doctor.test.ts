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
    expect(r.stdout).toMatch(/build: {2}v\d+\.\d+\.\d+ \(/)
    expect(r.stdout).toContain("terminal: TERM=")
    expect(r.stdout).toContain("running inside tmux:")
    expect(r.stdout).toContain("kitty keyboard protocol: skipped")
    expect(r.stdout).not.toContain("\x1b[?u")
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
