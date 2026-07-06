import { describe, expect, it, vi } from "vitest"
import { parseUpdateArgs, runUpdateSubcommand, updatePlan } from "../../src/cli/update.ts"
import { PACKAGE_NAME, UPDATE_COMMAND, UPDATE_SCRIPT_URL, recommendedGlobalInstallCommand } from "../../src/version.ts"

describe("updatePlan", () => {
  it("delegates to the GitHub-hosted update script", () => {
    expect(updatePlan()).toEqual({
      command: "sh",
      args: ["-c", UPDATE_COMMAND],
      display: UPDATE_COMMAND,
    })
    expect(UPDATE_COMMAND).toBe(`curl -fsSL ${UPDATE_SCRIPT_URL} | sh`)
    expect(recommendedGlobalInstallCommand()).toBe(`npm install -g ${PACKAGE_NAME}@latest`)
  })
})

describe("parseUpdateArgs", () => {
  it("parses dry-run", () => {
    expect(parseUpdateArgs(["--dry-run"])).toEqual({
      help: false,
      dryRun: true,
    })
  })

  it("recognizes every help spelling", () => {
    expect(parseUpdateArgs(["--help"])).toEqual({ help: true, dryRun: false })
    expect(parseUpdateArgs(["-h"])).toEqual({ help: true, dryRun: false })
    expect(parseUpdateArgs(["help"])).toEqual({ help: true, dryRun: false })
  })

  it("an unknown argument prints the error + full usage to stderr and exits 2", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    try {
      expect(() => parseUpdateArgs(["--fast"])).toThrow("exit 2")
      const err = errSpy.mock.calls.map((c) => String(c[0])).join("")
      expect(err).toContain('kobe update: unknown argument "--fast"')
      expect(err).toContain("Usage: kobe update [--dry-run]")
      expect(err).toContain(UPDATE_SCRIPT_URL)
      expect(err).toContain(recommendedGlobalInstallCommand())
    } finally {
      errSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })
})

describe("runUpdateSubcommand", () => {
  it("prints the command without spawning in dry-run mode", async () => {
    const out: string[] = []
    const err: string[] = []
    const spawn = vi.fn()
    const exit = vi.fn((code: number) => {
      throw new Error(`unexpected exit ${code}`)
    })

    await runUpdateSubcommand(["--dry-run"], {
      spawn: spawn as never,
      stdout: {
        write: (s: string) => {
          out.push(s)
          return true
        },
      },
      stderr: {
        write: (s: string) => {
          err.push(s)
          return true
        },
      },
      exit: exit as never,
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(err).toEqual([])
    expect(out.join("")).toContain(`running: ${UPDATE_COMMAND}`)
  })

  it("exits with the update script status", async () => {
    const spawn = vi.fn(() => ({ status: 7 }))
    const exits: number[] = []

    await runUpdateSubcommand([], {
      spawn: spawn as never,
      stdout: { write: () => true },
      stderr: { write: () => true },
      exit: ((code: number) => {
        exits.push(code)
        throw new Error("exit")
      }) as never,
    }).catch((err) => {
      expect((err as Error).message).toBe("exit")
    })

    expect(spawn).toHaveBeenCalledWith("sh", ["-c", UPDATE_COMMAND], { stdio: "inherit" })
    expect(exits).toEqual([7])
  })

  it("--help prints usage to STDOUT and never spawns or exits", async () => {
    const out: string[] = []
    const spawn = vi.fn()
    const exit = vi.fn((code: number) => {
      throw new Error(`unexpected exit ${code}`)
    })
    await runUpdateSubcommand(["--help"], {
      spawn: spawn as never,
      stdout: {
        write: (s: string) => {
          out.push(s)
          return true
        },
      },
      stderr: { write: () => true },
      exit: exit as never,
    })
    expect(out.join("")).toContain("Usage: kobe update [--dry-run]")
    expect(spawn).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it("a spawn failure (e.g. sh missing) reports the cause and exits 1", async () => {
    const err: string[] = []
    const exits: number[] = []
    const spawn = vi.fn(() => ({ error: new Error("ENOENT") }))
    await runUpdateSubcommand([], {
      spawn: spawn as never,
      stdout: { write: () => true },
      stderr: {
        write: (s: string) => {
          err.push(s)
          return true
        },
      },
      exit: ((code: number) => {
        exits.push(code)
        throw new Error("exit")
      }) as never,
    }).catch((e) => {
      expect((e as Error).message).toBe("exit")
    })
    expect(err.join("")).toContain("kobe update: failed to run sh: ENOENT")
    expect(exits).toEqual([1])
  })

  it("a null spawn status falls back to exit 1", async () => {
    const exits: number[] = []
    const spawn = vi.fn(() => ({ status: null }))
    await runUpdateSubcommand([], {
      spawn: spawn as never,
      stdout: { write: () => true },
      stderr: { write: () => true },
      exit: ((code: number) => {
        exits.push(code)
        throw new Error("exit")
      }) as never,
    }).catch(() => {})
    expect(exits).toEqual([1])
  })
})
