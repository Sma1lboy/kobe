/**
 * The published bins start under whichever runtime the installer chose
 * (Bun for `bun install -g`, node for `npm i -g` / `npx`), so the launcher's
 * Bun discovery is what keeps a Bun-less machine from getting
 * `env: bun: No such file or directory`. Pure functions here; the launcher
 * itself is a 60-line shell around them.
 */

import { describe, expect, it } from "vitest"
import {
  BUN_OVERRIDE_ENV,
  bunCandidates,
  bunInstallerCommand,
  canOfferBunInstall,
  exitCodeOf,
  installBun,
  launcherDirOf,
  launcherNameOf,
  missingBunMessage,
  relaunchWithBun,
  resolveBunBinary,
} from "../../src/cli/bun-runtime.ts"

const posix = { platform: "linux" as const, home: "/home/dev", env: { PATH: "/usr/bin:/opt/bin" } }

describe("bunCandidates", () => {
  it("puts an explicit override ahead of everything else", () => {
    const candidates = bunCandidates({ ...posix, env: { ...posix.env, [BUN_OVERRIDE_ENV]: "/custom/bun" } })

    expect(candidates[0]).toBe("/custom/bun")
    expect(candidates).toContain("/usr/bin/bun")
  })

  it("scans PATH, then BUN_INSTALL, then the default ~/.bun prefix", () => {
    const candidates = bunCandidates({ ...posix, env: { ...posix.env, BUN_INSTALL: "/opt/bun-install" } })

    expect(candidates).toEqual(["/usr/bin/bun", "/opt/bin/bun", "/opt/bun-install/bin/bun", "/home/dev/.bun/bin/bun"])
  })

  it("probes a `bun` npm package beside the install, which is never on PATH", () => {
    const candidates = bunCandidates({ ...posix, launcherDir: "/lib/node_modules/@sma1lboy/rove/dist/cli" })

    expect(candidates).toContain("/lib/node_modules/@sma1lboy/rove/node_modules/bun/bin/bun")
    expect(candidates).toContain("/lib/node_modules/@sma1lboy/bun/bin/bun")
  })

  it("looks for bun.exe on Windows and accepts USERPROFILE as the home", () => {
    const candidates = bunCandidates({ platform: "win32", env: { Path: "C:\\tools", USERPROFILE: "C:\\Users\\dev" } })

    expect(candidates.every((candidate) => candidate.endsWith("bun.exe"))).toBe(true)
  })
})

describe("resolveBunBinary", () => {
  it("returns the first executable candidate", () => {
    const found = resolveBunBinary({ ...posix, isExecutable: (path) => path === "/opt/bin/bun" })

    expect(found).toBe("/opt/bin/bun")
  })

  it("returns null when no candidate exists", () => {
    expect(resolveBunBinary({ ...posix, isExecutable: () => false })).toBeNull()
  })
})

describe("launcher identity", () => {
  it("derives the invoked CLI name from the launcher file", () => {
    expect(launcherNameOf("file:///lib/rove/dist/cli/rove.js")).toBe("rove")
    expect(launcherNameOf("file:///lib/rove/dist/cli/kobe.mjs")).toBe("kobe")
    expect(launcherDirOf("file:///lib/rove/dist/cli/rove.js")).toBe("/lib/rove/dist/cli")
  })
})

describe("install guidance", () => {
  it("offers the platform's own installer", () => {
    expect(bunInstallerCommand("darwin").join(" ")).toContain("https://bun.sh/install")
    expect(bunInstallerCommand("win32")[0]).toBe("powershell")
  })

  it("names every install route a user without Bun can take", () => {
    const message = missingBunMessage("rove", "linux")

    expect(message).toContain("curl -fsSL https://bun.sh/install | bash")
    expect(message).toContain("npm install -g bun")
    expect(message).toContain("install.sh")
    expect(message).toContain(BUN_OVERRIDE_ENV)
  })

  it("shows the PowerShell installer first on Windows", () => {
    expect(missingBunMessage("rove", "win32")).toContain("irm bun.sh/install.ps1")
  })
})

describe("canOfferBunInstall", () => {
  const tty = { isTTY: true }

  it("asks only when a human is there to answer", () => {
    expect(canOfferBunInstall({}, tty, tty)).toBe(true)
    expect(canOfferBunInstall({}, { isTTY: false }, tty)).toBe(false)
    expect(canOfferBunInstall({}, tty, { isTTY: false })).toBe(false)
  })

  it("never prompts in CI or when the escape hatch is set", () => {
    expect(canOfferBunInstall({ CI: "true" }, tty, tty)).toBe(false)
    expect(canOfferBunInstall({ ROVE_NO_BUN_BOOTSTRAP: "1" }, tty, tty)).toBe(false)
  })
})

const spawnResult = (over: Record<string, unknown> = {}) =>
  ({ status: 0, signal: null, error: undefined, ...over }) as never

describe("installBun", () => {
  it("re-probes the well-known prefixes after the installer ran", () => {
    const calls: string[][] = []
    const found = installBun({ ...posix, isExecutable: (path) => path === "/home/dev/.bun/bin/bun" }, (cmd, args) => {
      calls.push([cmd, ...args])
      return spawnResult()
    })

    expect(found).toBe("/home/dev/.bun/bin/bun")
    expect(calls[0]?.[0]).toBe("bash")
  })

  it("gives up when the installer fails", () => {
    expect(installBun({ ...posix, isExecutable: () => true }, () => spawnResult({ status: 1 }))).toBeNull()
  })
})

describe("relaunchWithBun", () => {
  it("hands the entry and argv to Bun with inherited stdio", () => {
    let seen: { cmd: string; args: readonly string[]; options: { stdio?: string } } | null = null
    const code = relaunchWithBun("/usr/bin/bun", "/dist/rove-run.js", ["api", "--pretty"], (cmd, args, options) => {
      seen = { cmd, args, options }
      return spawnResult({ status: 3 })
    })

    expect(code).toBe(3)
    expect(seen).toEqual({
      cmd: "/usr/bin/bun",
      args: ["/dist/rove-run.js", "api", "--pretty"],
      options: { stdio: "inherit" },
    })
  })

  it("reports a Bun that cannot be started instead of exiting 0", () => {
    expect(
      relaunchWithBun("/gone/bun", "/dist/rove-run.js", [], () => spawnResult({ error: new Error("ENOENT") })),
    ).toBe(1)
  })
})

describe("exitCodeOf", () => {
  it("passes a status through and maps a fatal signal the way a shell does", () => {
    expect(exitCodeOf({ status: 0, signal: null })).toBe(0)
    expect(exitCodeOf({ status: 2, signal: null })).toBe(2)
    expect(exitCodeOf({ status: null, signal: "SIGINT" })).toBe(130)
    expect(exitCodeOf({ status: null, signal: null })).toBe(1)
  })
})
