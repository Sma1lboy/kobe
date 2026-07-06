import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

const fake = vi.hoisted(() => ({
  tasks: [] as unknown[],
  loads: 0,
}))

vi.mock("../../src/orchestrator/index/store.ts", () => ({
  TaskIndexStore: class {
    async load() {
      fake.loads++
    }
    list() {
      return fake.tasks
    }
  },
}))

import { runExportSubcommand } from "../../src/cli/export-cmd.ts"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: toTaskId("01HZ0000000000000000000001"),
    title: "Fix the thing",
    repo: "/home/u/repo",
    branch: "kobe/fix-thing-01",
    worktreePath: "/home/u/.kobe/worktrees/repo/fix-thing-01",
    status: "in_progress",
    archived: false,
    vendor: "claude",
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    ...overrides,
  }
}

let outSpy: MockInstance<typeof process.stdout.write>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

beforeEach(() => {
  fake.tasks = [task()]
  fake.loads = 0
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
})

function out(): string {
  return outSpy.mock.calls.map((c) => String(c[0])).join("")
}
function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("runExportSubcommand", () => {
  it("--help prints usage without loading the store", async () => {
    await runExportSubcommand(["--help"])
    expect(out()).toContain("Usage: kobe export")
    expect(fake.loads).toBe(0)
  })

  it("defaults to a JSON array of the stored tasks", async () => {
    await runExportSubcommand([])
    const parsed = JSON.parse(out())
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe("01HZ0000000000000000000001")
    expect(fake.loads).toBe(1)
  })

  it("--csv prints a header row plus one row per task", async () => {
    await runExportSubcommand(["--csv"])
    const lines = out().trimEnd().split("\n")
    expect(lines[0]).toBe("id,title,status,archived,vendor,branch,repo,worktreePath")
    expect(lines).toHaveLength(2)
  })

  it("--format table prints aligned human-readable columns", async () => {
    await runExportSubcommand(["--format", "table"])
    const lines = out().trimEnd().split("\n")
    expect(lines[0].startsWith("id")).toBe(true)
    expect(lines[1]).toContain("Fix the thing")
  })

  it("--format=csv (equals form) works, and the LATER flag wins", async () => {
    await runExportSubcommand(["--json", "--format=csv"])
    expect(out().split("\n")[0]).toBe("id,title,status,archived,vendor,branch,repo,worktreePath")
  })

  it("an empty task list in table format says 'no tasks' instead of a lonely header", async () => {
    fake.tasks = []
    await runExportSubcommand(["--format", "table"])
    expect(out()).toBe("no tasks\n")
  })

  it("an empty list still emits [] for json (parseable by jq)", async () => {
    fake.tasks = []
    await runExportSubcommand(["--json"])
    expect(JSON.parse(out())).toEqual([])
  })

  it("--format without a value is a usage error, exit 2", async () => {
    await expect(runExportSubcommand(["--format"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--format requires a value")
    expect(err()).toContain("Usage: kobe export")
  })

  it("an unknown format is a usage error, exit 2", async () => {
    await expect(runExportSubcommand(["--format", "yaml"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unknown format "yaml"')
  })

  it("an unexpected argument is a usage error, exit 2", async () => {
    await expect(runExportSubcommand(["tasks.json"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unexpected argument "tasks.json"')
  })
})
