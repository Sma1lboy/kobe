import { describe, expect, it } from "vitest"
import { parseCliArgs } from "../../src/cli/daemon-mode.ts"
import { resolveDaemonMode } from "../../src/daemon/mode.ts"

describe("parseCliArgs", () => {
  it("maps --daemon to shared daemon mode", () => {
    expect(parseCliArgs(["--daemon"])).toEqual({ daemonMode: "shared", args: [] })
  })

  it("maps --single to explicit single daemon mode", () => {
    expect(parseCliArgs(["--single"])).toEqual({ daemonMode: "single", args: [] })
  })

  it("passes through subcommands and their args", () => {
    expect(parseCliArgs(["--daemon", "theme", "list"])).toEqual({
      daemonMode: "shared",
      args: ["theme", "list"],
    })
  })

  it("rejects conflicting daemon flags", () => {
    expect(() => parseCliArgs(["--daemon", "--single"])).toThrow(/cannot pass both/)
  })
})

describe("resolveDaemonMode", () => {
  it("prefers the CLI flag over the environment", () => {
    expect(resolveDaemonMode("single", { KOBE_DAEMON_MODE: "shared" })).toBe("single")
  })

  it("keeps KOBE_DAEMON_MODE=shared as a fallback", () => {
    expect(resolveDaemonMode(undefined, { KOBE_DAEMON_MODE: "shared" })).toBe("shared")
  })

  it("defaults to single-point mode", () => {
    expect(resolveDaemonMode(undefined, {})).toBe("single")
  })
})
