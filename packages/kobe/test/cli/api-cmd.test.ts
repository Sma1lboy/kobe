import { describe, expect, it } from "vitest"
import { API_VERBS, ApiError, apiUsage, parseFlags } from "../../src/cli/api-cmd.ts"

describe("parseFlags", () => {
  it("parses `--key value` pairs", () => {
    const { flags, pretty } = parseFlags(["--repo", "/x", "--prompt", "hello world"])
    expect(flags.get("repo")).toBe("/x")
    expect(flags.get("prompt")).toBe("hello world")
    expect(pretty).toBe(false)
  })

  it("parses `--key=value` pairs", () => {
    const { flags } = parseFlags(["--task-id=abc", "--title=My Task"])
    expect(flags.get("task-id")).toBe("abc")
    expect(flags.get("title")).toBe("My Task")
  })

  it("treats `--pretty` as a boolean flag", () => {
    expect(parseFlags(["--pretty"]).pretty).toBe(true)
    expect(parseFlags(["--pretty=false"]).pretty).toBe(false)
    expect(parseFlags(["--pretty=0"]).pretty).toBe(false)
    expect(parseFlags(["--pretty=true"]).pretty).toBe(true)
  })

  it("rejects a positional arg with BAD_FLAG", () => {
    try {
      parseFlags(["spawn-task"])
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe("BAD_FLAG")
    }
  })

  it("rejects a flag missing its value", () => {
    expect(() => parseFlags(["--repo"])).toThrow(/--repo requires a value/)
    // A following flag does not count as the value.
    expect(() => parseFlags(["--repo", "--prompt", "x"])).toThrow(/--repo requires a value/)
  })
})

describe("apiUsage", () => {
  it("documents every verb", () => {
    const usage = apiUsage()
    for (const verb of API_VERBS) {
      expect(usage).toContain(verb)
    }
  })
})

describe("API_VERBS", () => {
  it("is the v0.6 four-verb surface", () => {
    expect([...API_VERBS]).toEqual(["spawn-task", "send", "get-task", "list"])
  })
})
