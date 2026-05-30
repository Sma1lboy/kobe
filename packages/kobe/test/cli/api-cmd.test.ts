import { describe, expect, it } from "vitest"
import { API_VERBS, ApiError, apiUsage, parseAgentsSpec, parseFlags } from "../../src/cli/api-cmd.ts"

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

describe("parseAgentsSpec", () => {
  it("expands vendor:count pairs into one entry per task", () => {
    expect(parseAgentsSpec("claude:2,codex:1")).toEqual(["claude", "claude", "codex"])
  })

  it("tolerates whitespace and skips empty segments", () => {
    expect(parseAgentsSpec(" claude:1 , , codex:2 ")).toEqual(["claude", "codex", "codex"])
  })

  it("rejects an unknown vendor", () => {
    try {
      parseAgentsSpec("bogus:2")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe("BAD_FLAG")
    }
  })

  it("rejects a non-positive or malformed count", () => {
    expect(() => parseAgentsSpec("claude:0")).toThrow(/positive integer/)
    expect(() => parseAgentsSpec("claude")).toThrow(/vendor:count/)
  })

  it("rejects a spec that expands to nothing", () => {
    expect(() => parseAgentsSpec(" , ")).toThrow(/no agents/)
  })
})

describe("API_VERBS", () => {
  it("is the v0.6 six-verb surface", () => {
    expect([...API_VERBS]).toEqual(["spawn-task", "fan-out", "send", "get-task", "collect", "list"])
  })
})
