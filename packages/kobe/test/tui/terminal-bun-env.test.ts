import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BunTerminalTaskPty } from "../../src/tui/panes/terminal/pty"

const originalTermProgram = process.env.TERM_PROGRAM
const originalTermProgramVersion = process.env.TERM_PROGRAM_VERSION
const originalColorTerm = process.env.COLORTERM

interface SpawnOptions {
  env?: Record<string, string | undefined>
}

function restore(name: "COLORTERM" | "TERM_PROGRAM" | "TERM_PROGRAM_VERSION", value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

describe("BunTerminalTaskPty child environment", () => {
  const close = vi.fn()
  const kill = vi.fn()
  const spawn = vi.fn((_argv: readonly string[], _options: SpawnOptions) => ({
    exited: new Promise<void>(() => {}),
    kill,
    terminal: { close, resize: vi.fn(), write: vi.fn() },
    unref: vi.fn(),
  }))

  beforeEach(() => {
    process.env.COLORTERM = "truecolor"
    process.env.TERM_PROGRAM = "iTerm.app"
    process.env.TERM_PROGRAM_VERSION = "3.6.11"
    vi.stubGlobal("Bun", { spawn })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    restore("COLORTERM", originalColorTerm)
    restore("TERM_PROGRAM", originalTermProgram)
    restore("TERM_PROGRAM_VERSION", originalTermProgramVersion)
  })

  it("advertises xterm capabilities without leaking the outer emulator identity", () => {
    const pty = new BunTerminalTaskPty({
      taskId: "bun-env",
      cwd: process.cwd(),
      command: ["/bin/sh"],
      cols: 60,
      rows: 8,
    })

    expect(spawn).toHaveBeenCalledOnce()
    const options = spawn.mock.calls[0]?.[1]
    expect(options?.env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: "60",
      LINES: "8",
      KOBE_TERMINAL_PTY: "1",
    })
    expect(options?.env).not.toHaveProperty("TERM_PROGRAM")
    expect(options?.env).not.toHaveProperty("TERM_PROGRAM_VERSION")

    pty.kill()
    expect(close).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith("SIGTERM")
  })
})
