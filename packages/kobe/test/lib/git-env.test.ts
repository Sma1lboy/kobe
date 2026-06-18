import { describe, expect, test } from "vitest"
import { READ_ONLY_GIT_ENV, readOnlyGitProcessEnv } from "../../src/lib/git-env"

describe("read-only git env", () => {
  test("pins optional locks off for ExecHost env overlays", () => {
    expect(READ_ONLY_GIT_ENV).toEqual({ GIT_OPTIONAL_LOCKS: "0" })
  })

  test("merges over an existing process env", () => {
    expect(readOnlyGitProcessEnv({ PATH: "/bin", GIT_OPTIONAL_LOCKS: "1" })).toEqual({
      PATH: "/bin",
      GIT_OPTIONAL_LOCKS: "0",
    })
  })
})
