/**
 * `kobe skill <install|status|command>` (`runSkillSubcommand`). The pure
 * helpers from lib/skill-install stay real (npxSkillsArgv/Command are
 * deterministic); only the state probe is stubbed per-test and Bun.spawn is
 * stubbed so `install` never really runs npx.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  kobeSkillState: vi.fn(),
  kobeSkillPaths: vi.fn(() => ["/home/u/.claude/skills/kobe/SKILL.md", "/proj/.claude/skills/kobe/SKILL.md"]),
  bunSpawn: vi.fn(),
}))

vi.mock("../../src/lib/skill-install.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/skill-install.ts")>()
  return {
    ...actual,
    kobeSkillState: mocks.kobeSkillState,
    kobeSkillPaths: mocks.kobeSkillPaths,
  }
})

import { runSkillSubcommand } from "../../src/cli/skill-cmd.ts"
import { npxSkillsCommand } from "../../src/lib/skill-install.ts"

let outSpy: MockInstance<typeof process.stdout.write>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

beforeEach(() => {
  mocks.kobeSkillState.mockReset().mockReturnValue({
    installed: true,
    installedVersion: 2,
    currentVersion: 2,
    stale: false,
  })
  mocks.bunSpawn.mockReset().mockReturnValue({ exited: Promise.resolve(0) })
  vi.stubGlobal("Bun", { spawn: mocks.bunSpawn })

  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
  process.exitCode = undefined
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllGlobals()
  process.exitCode = undefined
})

function out(): string {
  return outSpy.mock.calls.map((c) => String(c[0])).join("")
}
function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("runSkillSubcommand usage / dispatch", () => {
  it("no verb prints usage and sets exitCode 2", async () => {
    await runSkillSubcommand([])
    expect(out()).toContain("usage: kobe skill")
    expect(process.exitCode).toBe(2)
  })

  it("--help prints usage without an error exit code", async () => {
    await runSkillSubcommand(["--help"])
    expect(out()).toContain("usage: kobe skill")
    expect(process.exitCode).toBeUndefined()
  })

  it("unknown verb exits 2 with usage on stderr", async () => {
    await expect(runSkillSubcommand(["bogus"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unknown verb "bogus"')
  })
})

describe("kobe skill status", () => {
  it("reports installed + up to date, listing both candidate paths", async () => {
    await runSkillSubcommand(["status"])
    const text = out()
    expect(text).toContain("✓ installed (v2)")
    expect(text).toContain("/home/u/.claude/skills/kobe/SKILL.md")
    expect(text).toContain("/proj/.claude/skills/kobe/SKILL.md")
    expect(text).not.toContain("run `kobe skill install`")
  })

  it("reports not installed with the install hint", async () => {
    mocks.kobeSkillState.mockReturnValue({ installed: false, installedVersion: null, currentVersion: 2, stale: false })
    await runSkillSubcommand(["status"])
    const text = out()
    expect(text).toContain("✗ not installed")
    expect(text).toContain("run `kobe skill install`")
  })

  it("reports an out-of-date skill (stamped) and an unstamped one", async () => {
    mocks.kobeSkillState.mockReturnValue({ installed: true, installedVersion: 1, currentVersion: 2, stale: true })
    await runSkillSubcommand(["status"])
    expect(out()).toContain("⚠ out of date (installed v1, this kobe wants v2)")

    outSpy.mockClear()
    mocks.kobeSkillState.mockReturnValue({ installed: true, installedVersion: null, currentVersion: 2, stale: true })
    await runSkillSubcommand(["status"])
    expect(out()).toContain("out of date (installed unstamped, this kobe wants v2)")
  })
})

describe("kobe skill command", () => {
  it("prints the underlying npx command for the default agent without running it", async () => {
    await runSkillSubcommand(["command"])
    expect(out().trim()).toBe(npxSkillsCommand({ agent: "claude-code" }))
    expect(mocks.bunSpawn).not.toHaveBeenCalled()
  })

  it("--agent switches the target agent (both flag spellings)", async () => {
    await runSkillSubcommand(["command", "--agent", "cursor"])
    expect(out()).toContain("--agent cursor")

    outSpy.mockClear()
    await runSkillSubcommand(["command", "--agent=windsurf"])
    expect(out()).toContain("--agent windsurf")
  })

  it("--agent without a value exits 2", async () => {
    await expect(runSkillSubcommand(["command", "--agent"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--agent requires a value")
  })

  it("an unknown flag exits 2 with usage", async () => {
    await expect(runSkillSubcommand(["command", "--bogus"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unknown flag "--bogus"')
  })
})

describe("kobe skill install", () => {
  it("spawns npx with the skills-add argv and reports success on exit 0", async () => {
    await runSkillSubcommand(["install"])
    expect(mocks.bunSpawn).toHaveBeenCalledWith(
      ["npx", "skills", "add", "Sma1lboy/kobe", "--skill", "kobe", "--agent", "claude-code"],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    )
    expect(out()).toContain("kobe skill: installed.")
  })

  it("propagates a non-zero npx exit code and prints the manual command", async () => {
    mocks.bunSpawn.mockReturnValue({ exited: Promise.resolve(3) })
    await expect(runSkillSubcommand(["install"])).rejects.toThrow("exit 3")
    expect(err()).toContain("kobe skill install failed (npx exited 3)")
    expect(err()).toContain(npxSkillsCommand({ agent: "claude-code" }))
  })

  it("install --agent NAME threads the agent through to npx", async () => {
    await runSkillSubcommand(["install", "--agent", "cursor"])
    expect(mocks.bunSpawn).toHaveBeenCalledWith(expect.arrayContaining(["--agent", "cursor"]), expect.anything())
  })
})
