import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveEditorCommand: vi.fn(),
  binaryAvailable: vi.fn(),
}))

vi.mock("../../src/tui/lib/editor-launch.ts", () => ({
  resolveEditorCommand: mocks.resolveEditorCommand,
  binaryAvailable: mocks.binaryAvailable,
}))

import { runConfigSubcommand } from "../../src/cli/config-cmd.ts"

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit:${code}`)
  }
}

let home: string
let originalHome: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

const configPath = (): string => join(home, ".config", "kobe", "state.json")

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-config-"))
  process.env.KOBE_HOME_DIR = home
  mocks.resolveEditorCommand.mockReset()
  mocks.binaryAvailable.mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("runConfigSubcommand", () => {
  it("--path prints the config file path without opening an editor", async () => {
    await runConfigSubcommand(["--path"])
    expect(logSpy).toHaveBeenCalledWith(configPath())
    expect(mocks.resolveEditorCommand).not.toHaveBeenCalled()
  })

  it("--help prints usage without opening an editor", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runConfigSubcommand(["--help"])
    expect(outSpy.mock.calls.join("")).toContain("Usage: kobe config")
    expect(mocks.resolveEditorCommand).not.toHaveBeenCalled()
    outSpy.mockRestore()
  })

  it("rejects an unknown argument with exit code 2", async () => {
    await expect(runConfigSubcommand(["--nope"])).rejects.toBeInstanceOf(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it("seeds an empty config and errors out (exit 1) when no editor is available", async () => {
    mocks.resolveEditorCommand.mockResolvedValue(null)
    await expect(runConfigSubcommand([])).rejects.toBeInstanceOf(ExitError)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(existsSync(configPath())).toBe(true)
    expect(readFileSync(configPath(), "utf8")).toBe("{}\n")
    expect(errSpy.mock.calls.join("")).toContain("no editor")
  })

  it("spawns the resolved editor on the config path and exits with its code", async () => {
    mocks.resolveEditorCommand.mockResolvedValue({ bin: "vim", command: `vim ${configPath()}` })
    mocks.binaryAvailable.mockResolvedValue(true)
    const spawn = vi.fn(() => ({ exited: Promise.resolve(0) }))
    vi.stubGlobal("Bun", { spawn })

    await expect(runConfigSubcommand([])).rejects.toBeInstanceOf(ExitError)

    expect(spawn).toHaveBeenCalledWith(
      ["sh", "-c", `vim ${configPath()}`],
      expect.objectContaining({ stdin: "inherit" }),
    )
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
