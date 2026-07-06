import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { runCompletionsSubcommand } from "../../src/cli/completions-cmd.ts"
import { TOP_LEVEL_SUBCOMMANDS } from "../../src/cli/subcommands.ts"

let stdoutSpy: MockInstance
let stderrSpy: MockInstance
let exitSpy: ReturnType<typeof vi.fn>

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("")
}

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.fn(() => {
    throw new Error("exit sentinel")
  })
  vi.spyOn(process, "exit").mockImplementation(exitSpy as unknown as typeof process.exit)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runCompletionsSubcommand", () => {
  test("bash script registers the completion fn and lists every subcommand", async () => {
    await runCompletionsSubcommand(["bash"])
    const script = stdoutText()
    expect(script).toContain("complete -F _kobe kobe")
    for (const sub of TOP_LEVEL_SUBCOMMANDS) expect(script).toContain(sub)
  })

  test("zsh script is a #compdef carrying every subcommand", async () => {
    await runCompletionsSubcommand(["zsh"])
    const script = stdoutText()
    expect(script.startsWith("#compdef kobe")).toBe(true)
    for (const sub of TOP_LEVEL_SUBCOMMANDS) expect(script).toContain(`"${sub}"`)
  })

  test("fish script emits one complete line per subcommand", async () => {
    await runCompletionsSubcommand(["fish"])
    const script = stdoutText()
    for (const sub of TOP_LEVEL_SUBCOMMANDS) expect(script).toContain(`complete -c kobe -f -a ${sub}`)
  })

  test("--help prints usage without exiting non-zero", async () => {
    await runCompletionsSubcommand(["--help"])
    expect(stdoutText()).toContain("Usage: kobe completions")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("an unknown shell prints usage to stderr and exits 2", async () => {
    await expect(runCompletionsSubcommand(["powershell"])).rejects.toThrow("exit sentinel")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toContain('unknown shell "powershell"')
  })

  test("a missing shell argument is the same usage error", async () => {
    await expect(runCompletionsSubcommand([])).rejects.toThrow("exit sentinel")
    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})
