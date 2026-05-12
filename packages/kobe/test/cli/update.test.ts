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
})
