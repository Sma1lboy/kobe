/**
 * `kobe doctor` black-box behavior — the DIST build, piped, fresh home.
 *
 * Why this exists: doctor/update-class regressions kept shipping with green
 * unit tests because the failures lived in the environment (packaged-vs-dev
 * paths, PATH state, TTY-vs-pipe), which mocks faked away. This suite runs
 * the real CLI against a real (temp) environment and asserts the visible
 * surface: exit codes + the report lines a bug reporter would paste.
 */

import { tmpdir } from "node:os"
import { join } from "node:path"
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

  // Regression (owner report 2026-07-10): behavior tests launched from a
  // live KOBE_TUI process inherited its production socket + mode overrides.
  // Their teardown then ran `kobe reset --yes` against the real daemon/PTY
  // host/tmux session instead of the disposable home.
  it("scrubs every inherited KOBE control and isolates the OS home", async () => {
    const poisoned: Record<string, string> = {
      KOBE_DAEMON_SOCKET_PATH: join(tmpdir(), "production-daemon.sock"),
      KOBE_DAEMON_PID_PATH: join(tmpdir(), "production-daemon.pid"),
      KOBE_PTY_SOCKET_PATH: join(tmpdir(), "production-pty.sock"),
      KOBE_PTY_PID_PATH: join(tmpdir(), "production-pty.pid"),
      KOBE_TMUX_SOCKET: "production-tmux",
      KOBE_TUI: "1",
      KOBE_TERMINAL_PTY: "1",
      TMUX: "/tmp/tmux-production/default,1,0",
      TMUX_PANE: "%99",
      TERM: "screen-256color",
      TERM_PROGRAM: "production-terminal",
      TERM_PROGRAM_VERSION: "1.0",
    }
    const previous = new Map(Object.keys(poisoned).map((key) => [key, process.env[key]]))
    Object.assign(process.env, poisoned)

    let isolated: BehaviorEnv | undefined
    try {
      isolated = await makeBehaviorEnv()
      const kobeKeys = Object.keys(isolated.env)
        .filter((key) => key.startsWith("KOBE_"))
        .sort()
      expect(kobeKeys).toEqual(["KOBE_HOME_DIR", "KOBE_TMUX_SOCKET"])
      expect(isolated.env.HOME).toBe(isolated.home)
      expect(isolated.env.TMUX).toBeUndefined()
      expect(isolated.env.TMUX_PANE).toBeUndefined()
      expect(isolated.env.TERM).toBe("xterm-256color")
      expect(isolated.env.TERM_PROGRAM).toBeUndefined()

      const r = runKobe(["doctor"], isolated)
      expect(r.stdout).toContain(isolated.home)
      expect(r.stdout).not.toContain(poisoned.KOBE_DAEMON_SOCKET_PATH)

      // Defense in depth: even if a test mutates the already-clean child env,
      // teardown must refuse to run its destructive `kobe reset --yes`.
      isolated.env.KOBE_DAEMON_SOCKET_PATH = poisoned.KOBE_DAEMON_SOCKET_PATH
      await expect(isolated.dispose()).rejects.toThrow("behavior harness refusing destructive teardown")
      isolated = undefined
    } finally {
      await isolated?.dispose()
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }
  })

  it("rejects unexpected arguments with usage on stderr, exit 2", () => {
    const r = runKobe(["doctor", "--bogus"], env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("unexpected argument")
    expect(r.stderr).toContain("Usage: kobe doctor")
  })
})
