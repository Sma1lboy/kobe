import { describe, expect, it } from "vitest"
import {
  API_VERBS,
  ApiError,
  VERBS,
  apiUsage,
  buildCountPlan,
  findVerb,
  fullSchema,
  parseAgentsSpec,
  parseFlags,
  schemaIndex,
  validateAgainstSpec,
  verbHelp,
  verbSchema,
} from "../../src/cli/api-cmd.ts"

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

  it("rejects an over-cap count before allocating (no OOM on a huge count)", () => {
    // Guards against `--agents claude:1000000000` building a billion-element
    // array before the post-build cap check rejects it.
    expect(() => parseAgentsSpec("claude:1000000000")).toThrow(/exceeds the cap/)
    expect(() => parseAgentsSpec("claude:6,codex:6")).toThrow(/exceeds the cap/)
  })

  it("rejects a spec that expands to nothing", () => {
    expect(() => parseAgentsSpec(" , ")).toThrow(/no agents/)
  })
})

describe("buildCountPlan", () => {
  it("expands --count N into N copies of the vendor", () => {
    expect(buildCountPlan(3, "codex")).toEqual(["codex", "codex", "codex"])
    expect(buildCountPlan(1, "claude")).toEqual(["claude"])
  })

  it("rejects an over-cap count BEFORE allocating (no OOM on a huge --count)", () => {
    // Mirrors the parseAgentsSpec guard: `--count 1000000000` must fail fast
    // instead of building a billion-element array only to hit the post-build
    // cap check.
    expect(() => buildCountPlan(1_000_000_000, "claude")).toThrow(/exceeds the cap/)
    expect(() => buildCountPlan(11, "claude")).toThrow(/exceeds the cap/)
  })
})

describe("parseFlags boolean presence flags", () => {
  it("treats a verb's bool flag as standalone presence (--force ⇒ true)", () => {
    const { flags } = parseFlags(["--task-id", "t1", "--force"], new Set(["force"]))
    expect(flags.get("force")).toBe("true")
    expect(flags.get("task-id")).toBe("t1")
  })

  it("still requires a value for a non-boolean trailing flag", () => {
    expect(() => parseFlags(["--task-id"])).toThrow(/--task-id requires a value/)
  })

  it("parses --help / -h", () => {
    expect(parseFlags(["--help"]).help).toBe(true)
    expect(parseFlags(["-h"]).help).toBe(true)
    expect(parseFlags([]).help).toBe(false)
  })
})

describe("API surface (full CRUD)", () => {
  it("exposes the full task lifecycle, not just the old six", () => {
    for (const v of [
      "schema",
      "list",
      "get-task",
      "add",
      "fan-out",
      "send",
      "feedback",
      "collect",
      "rename",
      "set-branch",
      "set-vendor",
      "set-status",
      "archive",
      "pin",
      "set-active",
      "ensure-worktree",
      "delete",
      "discover-adoptable",
      "adopt",
    ]) {
      expect(API_VERBS).toContain(v)
    }
  })

  it("keeps `spawn-task` working as an alias of `add`", () => {
    expect(findVerb("spawn-task")?.name).toBe("add")
  })

  it("the compact index lists every verb + summary but NO flags (context economy)", () => {
    const idx = schemaIndex() as { verbs: { name: string; group: string; summary: string; flags?: unknown }[] }
    expect(idx.verbs.map((v) => v.name)).toEqual([...API_VERBS])
    // Crucially, the index does NOT carry per-verb flags — that's the drill-in level.
    for (const v of idx.verbs) expect(v.flags).toBeUndefined()
    expect(idx.verbs.find((v) => v.name === "add")?.group).toBe("create")
  })

  it("drill-in (verbSchema) carries one verb's full flag detail", () => {
    const add = findVerb("add")!
    const detail = verbSchema(add) as { name: string; flags: { name: string; type: string }[] }
    expect(detail.name).toBe("add")
    expect(detail.flags.find((f) => f.name === "repo")).toMatchObject({ required: true, type: "string" })
    expect(detail.flags.find((f) => f.name === "status")).toMatchObject({ type: "enum" })
  })

  it("--all (fullSchema) covers every verb WITH flags", () => {
    const full = fullSchema() as { verbs: { name: string; flags: unknown[] }[] }
    expect(full.verbs.map((v) => v.name)).toEqual([...API_VERBS])
    expect(full.verbs.every((v) => Array.isArray(v.flags))).toBe(true)
  })

  it("documents the feedback discussion verb with its default category", () => {
    const feedback = findVerb("feedback")!
    expect(feedback.offline).toBe(true)
    const detail = verbSchema(feedback) as { group: string; flags: { name: string; default?: string }[] }
    expect(detail.group).toBe("feedback")
    expect(detail.flags.find((f) => f.name === "category")).toMatchObject({ default: "feedback" })
  })

  it("verbHelp renders a signature + flags for every verb", () => {
    for (const v of VERBS) {
      const help = verbHelp(v)
      expect(help).toContain(`kobe api ${v.name}`)
      for (const f of v.flags) expect(help).toContain(`--${f.name}`)
    }
  })
})

describe("validateAgainstSpec", () => {
  const add = findVerb("add")!

  it("rejects an unknown flag with BAD_FLAG", () => {
    const { flags } = parseFlags(["--repo", "/x", "--bogus", "1"])
    expect(() => validateAgainstSpec(add, flags)).toThrow(/unknown flag --bogus/)
  })

  it("rejects a missing required flag with MISSING_FLAG", () => {
    const { flags } = parseFlags(["--title", "t"])
    try {
      validateAgainstSpec(add, flags)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as ApiError).code).toBe("MISSING_FLAG")
    }
  })

  it("rejects an out-of-range enum value", () => {
    const { flags } = parseFlags(["--repo", "/x", "--status", "nonsense"])
    expect(() => validateAgainstSpec(add, flags)).toThrow(/must be one of/)
  })

  it("accepts a well-formed invocation", () => {
    const { flags } = parseFlags(["--repo", "/x", "--status", "in_progress", "--vendor", "claude"])
    expect(() => validateAgainstSpec(add, flags)).not.toThrow()
  })
})
