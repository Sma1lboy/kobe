import { describe, expect, test } from "vitest"
import { parseArgv } from "../src/lib/argv.ts"

describe("parseArgv", () => {
  test("returns all three flags when present", () => {
    expect(parseArgv(["--task-id", "t1", "--worktree", "/tmp", "--target-pane", "=p:0.0"])).toEqual({
      taskId: "t1",
      worktree: "/tmp",
      targetPane: "=p:0.0",
    })
  })

  test("missing required flags yield undefined", () => {
    expect(parseArgv([])).toEqual({})
  })

  test("ignores unknown flags so a newer kobe doesn't crash an older kobe-ops", () => {
    expect(parseArgv(["--task-id", "t1", "--future-flag", "x"])).toEqual({ taskId: "t1" })
  })
})
