import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({
  openError: null as Error | null,
  request: vi.fn(async (_name: string, _payload?: unknown) => ({ tasks: [] })),
  closed: 0,
}))

vi.mock("../../src/cli/daemon-session.ts", () => ({
  openDaemonSession: vi.fn(async () => {
    if (fake.openError) throw fake.openError
    return {
      client: { request: fake.request, subscribe: async () => {}, on: () => () => {} },
      close: () => {
        fake.closed++
      },
    }
  }),
}))

const { runApiSubcommand } = await import("../../src/cli/api-cmd.ts")

let stdoutSpy: MockInstance
let stderrSpy: MockInstance
let exitSpy: ReturnType<typeof vi.fn>

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("")
}

function stderrJson(): { error: { message: string; code: string } } {
  return JSON.parse(stderrSpy.mock.calls.map((c) => String(c[0])).join(""))
}

beforeEach(() => {
  fake.openError = null
  fake.closed = 0
  fake.request.mockClear()
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.fn((code?: number) => {
    throw new Error(`exit(${code})`)
  })
  vi.spyOn(process, "exit").mockImplementation(exitSpy as unknown as typeof process.exit)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runApiSubcommand", () => {
  test("no verb → usage as a JSON error on stderr, exit 2", async () => {
    await expect(runApiSubcommand([])).rejects.toThrow("exit(2)")
    expect(stderrJson().error.code).toBe("MISSING_VERB")
  })

  test("help prints usage to stdout without exiting", async () => {
    await runApiSubcommand(["--help"])
    expect(stdoutText()).toContain("kobe api")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("unknown verb → BAD_VERB, exit 2", async () => {
    await expect(runApiSubcommand(["frobnicate"])).rejects.toThrow("exit(2)")
    expect(stderrJson().error.code).toBe("BAD_VERB")
  })

  test("verb --help prints the verb's flag help without running it", async () => {
    await runApiSubcommand(["schema", "--help"])
    expect(stdoutText()).toContain("schema")
    expect(fake.request).not.toHaveBeenCalled()
  })

  test("an unknown flag fails validation as a JSON error, exit 2", async () => {
    await expect(runApiSubcommand(["schema", "--bogus", "x"])).rejects.toThrow("exit(2)")
    const err = stderrJson().error
    expect(err.message).toContain("bogus")
  })

  test("a positional argument is a parse-stage BAD_FLAG JSON error, exit 2", async () => {
    await expect(runApiSubcommand(["list", "positional"])).rejects.toThrow("exit(2)")
    const err = stderrJson().error
    expect(err.code).toBe("BAD_FLAG")
    expect(err.message).toContain("unexpected positional arg: positional")
  })

  test("an offline verb emits its JSON result without touching the daemon", async () => {
    const { openDaemonSession } = await import("../../src/cli/daemon-session.ts")
    await runApiSubcommand(["schema"])
    expect(openDaemonSession).not.toHaveBeenCalled()
    const out = JSON.parse(stdoutText())
    expect(out).toHaveProperty("groups")
  })

  test("--pretty pretty-prints the emitted JSON", async () => {
    await runApiSubcommand(["schema", "--pretty"])
    expect(stdoutText()).toContain("\n  ")
  })

  test("a daemon-backed verb that can't reach the daemon fails BAD_DAEMON, exit 2", async () => {
    fake.openError = new Error("socket refused")
    await expect(runApiSubcommand(["list"])).rejects.toThrow("exit(2)")
    const err = stderrJson().error
    expect(err.code).toBe("BAD_DAEMON")
    expect(err.message).toContain("socket refused")
  })

  test("a daemon-backed verb runs against the session and always closes it", async () => {
    fake.request.mockResolvedValue({ tasks: [] })
    await runApiSubcommand(["list"])
    expect(fake.request).toHaveBeenCalledWith("task.list")
    expect(fake.closed).toBe(1)
    expect(JSON.parse(stdoutText())).toHaveProperty("tasks")
  })

  test("a handler RPC failure is a JSON error with exit 1 — and the session still closes", async () => {
    fake.request.mockRejectedValue(new Error("boom from daemon"))
    await expect(runApiSubcommand(["list"])).rejects.toThrow("exit(1)")
    expect(stderrJson().error.message).toContain("boom from daemon")
    expect(fake.closed).toBe(1)
  })
})
