import { describe, expect, it } from "vitest"
import { parseSandboxArgs, sandboxChildEnv } from "../../scripts/dev-sandbox-args"

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
  it("overrides ambient home aliases and preserves ROVE_* port precedence", () => {
    const env = sandboxChildEnv("/tmp/isolated", {
      ROVE_HOME_DIR: "/real-rove-home",
      KOBE_HOME_DIR: "/real-kobe-home",
      ROVE_DAEMON_WEB_PORT: "6123",
      KOBE_DAEMON_WEB_PORT: "4999",
    })

    expect(env.ROVE_HOME_DIR).toBe("/tmp/isolated")
    expect(env.KOBE_HOME_DIR).toBe("/tmp/isolated")
    expect(env.ROVE_DEV).toBe("1")
    expect(env.KOBE_DEV).toBe("1")
    expect(env.ROVE_DAEMON_WEB_PORT).toBe("6123")
    expect(env.KOBE_DAEMON_WEB_PORT).toBe("6123")
  })
})
