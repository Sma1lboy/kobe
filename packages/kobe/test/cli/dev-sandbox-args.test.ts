import { describe, expect, it } from "vitest"
import { SANDBOX_DAEMON_WEB_PORT, parseSandboxArgs, sandboxChildEnv } from "../../scripts/dev-sandbox-args"

describe("parseSandboxArgs", () => {
  it("defaults to the sole run mode", () => {
    expect(parseSandboxArgs(["run"])).toEqual({ mode: "run" })
    expect(parseSandboxArgs([])).toEqual({ mode: "run" })
  })

  it("keeps reset and home unchanged", () => {
    expect(parseSandboxArgs(["reset"])).toEqual({ mode: "reset" })
    expect(parseSandboxArgs(["home"])).toEqual({ mode: "home" })
  })

  it("rejects retired launch flags and extra arguments", () => {
    expect(() => parseSandboxArgs(["--tmux"])).toThrow('unknown sandbox mode "--tmux"')
    expect(() => parseSandboxArgs(["run", "extra"])).toThrow('unexpected argument "extra"')
  })
})

describe("sandboxChildEnv", () => {
  it("overrides ambient home aliases in both namespaces", () => {
    const env = sandboxChildEnv("/tmp/isolated", {
      ROVE_HOME_DIR: "/real-rove-home",
      KOBE_HOME_DIR: "/real-kobe-home",
    })

    expect(env.ROVE_HOME_DIR).toBe("/tmp/isolated")
    expect(env.KOBE_HOME_DIR).toBe("/tmp/isolated")
    expect(env.ROVE_DEV).toBe("1")
    expect(env.KOBE_DEV).toBe("1")
  })

  // The prod 2026-08-13 socket hijack: a TUI stamps the production socket onto
  // every task terminal it spawns, and an explicit socket path outranks
  // HOME_DIR — so an inherited one made the sandbox daemon bind the REAL
  // socket and serve its empty task index to attached TUIs.
  it("drops inherited socket and pid overrides that would outrank the sandbox home", () => {
    const env = sandboxChildEnv("/tmp/isolated", {
      KOBE_DAEMON_SOCKET_PATH: "/run/user/1000/kobe.sock",
      ROVE_DAEMON_SOCKET_PATH: "/run/user/1000/kobe.sock",
      KOBE_PTY_SOCKET_PATH: "/run/user/1000/kobe-pty.sock",
      ROVE_PTY_SOCKET_PATH: "/run/user/1000/kobe-pty.sock",
      KOBE_DAEMON_PID_PATH: "/home/dev/.kobe/daemon.pid",
      ROVE_DAEMON_PID_PATH: "/home/dev/.kobe/daemon.pid",
      KOBE_PTY_PID_PATH: "/home/dev/.kobe/pty.pid",
      ROVE_PTY_PID_PATH: "/home/dev/.kobe/pty.pid",
    })

    for (const key of ["DAEMON_SOCKET_PATH", "DAEMON_PID_PATH", "PTY_SOCKET_PATH", "PTY_PID_PATH"]) {
      expect(env[`KOBE_${key}`]).toBeUndefined()
      expect(env[`ROVE_${key}`]).toBeUndefined()
    }
    expect(env.KOBE_HOME_DIR).toBe("/tmp/isolated")
  })

  it("ignores an ambient production web port and uses the sandbox default", () => {
    const env = sandboxChildEnv("/tmp/isolated", {
      ROVE_DAEMON_WEB_PORT: "45174",
      KOBE_DAEMON_WEB_PORT: "45174",
    })

    expect(env.ROVE_DAEMON_WEB_PORT).toBe(SANDBOX_DAEMON_WEB_PORT)
    expect(env.KOBE_DAEMON_WEB_PORT).toBe(SANDBOX_DAEMON_WEB_PORT)
  })

  it("still honours an explicitly sandbox-scoped web port", () => {
    const env = sandboxChildEnv("/tmp/isolated", {
      ROVE_SANDBOX_DAEMON_WEB_PORT: "6123",
      KOBE_DAEMON_WEB_PORT: "45174",
    })

    expect(env.ROVE_DAEMON_WEB_PORT).toBe("6123")
    expect(env.KOBE_DAEMON_WEB_PORT).toBe("6123")
  })
})
