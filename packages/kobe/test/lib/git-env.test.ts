import { describe, expect, test } from "vitest"
import { readOnlyGitProcessEnv } from "../../src/lib/git-env"

describe("read-only git env", () => {
  test("merges over an existing process env", () => {
    expect(readOnlyGitProcessEnv({ PATH: "/bin", GIT_OPTIONAL_LOCKS: "1" })).toEqual({
      PATH: "/bin",
      GIT_OPTIONAL_LOCKS: "0",
    })
  })
})
