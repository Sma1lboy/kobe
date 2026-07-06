import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runRepoSubcommand } from "../../src/cli/repo-cmd.ts"

let home: string
let repo: string
let originalHome: string | undefined
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-repo-cmd-"))
  process.env.KOBE_HOME_DIR = home

  repo = join(home, "scratch-repo")
  mkdirSync(repo, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: repo })

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
})

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

function stateJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".config", "kobe", "state.json"), "utf8"))
}

describe("runRepoSubcommand usage", () => {
  it("prints usage on --help / no verb without exiting non-zero", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runRepoSubcommand(["--help"])
    await runRepoSubcommand([])
    expect(outSpy.mock.calls.join("")).toContain("Usage: kobe repo")
    expect(exitSpy).not.toHaveBeenCalled()
    outSpy.mockRestore()
  })

  it("rejects an unknown verb with usage + exit 2", async () => {
    await expect(runRepoSubcommand(["bogus"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unknown verb "bogus"')
  })
})

describe("kobe repo set / show / unset round-trip", () => {
  it("set writes the override into state.json keyed by the git toplevel", async () => {
    await runRepoSubcommand(["set", repo, "--init-script", "echo hi", "--init-prompt", "start here"])
    const out = output()
    expect(out).toContain(`updated override for ${repo}`)
    expect(out).toContain('initScript: "echo hi"')
    expect(out).toContain('initPrompt: "start here"')

    const configs = stateJson().repoConfigs as Record<string, { initScript?: string; initPrompt?: string }>
    expect(configs[repo]).toEqual({ initScript: "echo hi", initPrompt: "start here" })
  })

  it("show reports the override and whether .kobe/ files are present", async () => {
    await runRepoSubcommand(["set", repo, "--init-script", "echo hi"])
    logSpy.mockClear()

    mkdirSync(join(repo, ".kobe"), { recursive: true })
    writeFileSync(join(repo, ".kobe", "init.sh"), "echo repo-file", "utf8")

    await runRepoSubcommand(["show", repo])
    const out = output()
    expect(out).toContain(`repo: ${repo}`)
    expect(out).toContain(".kobe/init.sh:        present (wins)")
    expect(out).toContain(".kobe/init-prompt.md: absent")
    expect(out).toContain('override initScript:  "echo hi"')
    expect(out).toContain("override initPrompt:  (unset)")
  })

  it("show truncates a long override to a 60-char one-line preview", async () => {
    const long = `echo ${"x".repeat(100)}\necho second line`
    await runRepoSubcommand(["set", repo, "--init-script", long])
    logSpy.mockClear()
    await runRepoSubcommand(["show", repo])
    const line = output()
      .split("\n")
      .find((l) => l.includes("override initScript"))
    expect(line).toContain("…")
    expect(line).not.toContain("\n")
  })

  it("unset with a field flag clears only that field", async () => {
    await runRepoSubcommand(["set", repo, "--init-script", "s", "--init-prompt", "p"])
    logSpy.mockClear()

    await runRepoSubcommand(["unset", repo, "--init-script"])
    expect(output()).toContain("cleared override for")
    const configs = stateJson().repoConfigs as Record<string, { initScript?: string; initPrompt?: string }>
    expect(configs[repo]).toEqual({ initPrompt: "p" })
  })

  it("unset with no field flags clears both and drops the repo entry", async () => {
    await runRepoSubcommand(["set", repo, "--init-script", "s", "--init-prompt", "p"])
    await runRepoSubcommand(["unset", repo])
    const configs = stateJson().repoConfigs as Record<string, unknown>
    expect(configs[repo]).toBeUndefined()
  })

  it("set --init-script-file reads the script from disk", async () => {
    const file = join(home, "init-src.sh")
    writeFileSync(file, "echo from-file", "utf8")
    await runRepoSubcommand(["set", repo, "--init-script-file", file])
    const configs = stateJson().repoConfigs as Record<string, { initScript?: string }>
    expect(configs[repo]?.initScript).toBe("echo from-file")
  })
})

describe("runRepoSubcommand argument errors", () => {
  it("set with no override flags fails usage", async () => {
    await expect(runRepoSubcommand(["set", repo])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain("set needs at least one of")
  })

  it("set with a flag missing its value fails usage", async () => {
    await expect(runRepoSubcommand(["set", repo, "--init-script"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain("--init-script requires a value")
  })

  it("set with an unknown flag fails usage", async () => {
    await expect(runRepoSubcommand(["set", repo, "--bogus", "x"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unknown flag "--bogus"')
  })

  it("set with an unreadable --init-script-file fails usage", async () => {
    await expect(runRepoSubcommand(["set", repo, "--init-script-file", join(home, "missing.sh")])).rejects.toThrow(
      "exit 2",
    )
    expect(errSpy.mock.calls.join("")).toContain("cannot read")
  })

  it("unset with an unknown flag fails usage", async () => {
    await expect(runRepoSubcommand(["unset", repo, "--bogus"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unknown flag "--bogus"')
  })

  it("set with two positional paths fails usage", async () => {
    await expect(runRepoSubcommand(["set", repo, "other", "--init-script", "x"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unexpected argument "other"')
  })
})
