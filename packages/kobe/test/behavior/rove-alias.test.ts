import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { CURRENT_VERSION } from "../../src/version.ts"
import { type BehaviorEnv, makeBehaviorEnv, runKobe, runRove } from "./harness.ts"

describe("rove CLI compatibility entry", () => {
  let behavior: BehaviorEnv

  beforeAll(async () => {
    behavior = await makeBehaviorEnv()
  })

  afterAll(async () => {
    await behavior.dispose()
  })

  test("reports the rove command name for version and help", () => {
    const version = runRove(["--version"], behavior)
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toBe(`rove ${CURRENT_VERSION}`)

    const help = runRove(["--help"], behavior)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("Usage: rove [command] [options]")
  })

  test("generates completions for rove rather than the legacy alias", () => {
    const result = runRove(["completions", "bash"], behavior)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("complete -F _rove rove")
    expect(result.stdout).not.toContain("complete -F _kobe kobe")
  })

  test("subcommand help consistently names the invoked rove executable", () => {
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [["api", "--help"], "usage: rove api"],
      [["config", "--help"], "Usage: rove config"],
      [["daemon", "--help"], "Usage: rove daemon"],
      [["doctor", "--help"], "Usage: rove doctor"],
      [["export", "--help"], "Usage: rove export"],
      [["feedback", "--help"], "Usage: rove feedback"],
      [["plugin", "--help"], "usage: rove plugin"],
      [["repo", "--help"], "Usage: rove repo"],
      [["reset", "--help"], "Usage: rove reset"],
      [["skill", "--help"], "usage: rove skill"],
      [["theme", "--help"], "Usage: rove theme"],
      [["update", "--help"], "Usage: rove update"],
      [["web", "--help"], "Usage: rove web"],
    ]

    for (const [args, expected] of cases) {
      const result = runRove(args, behavior)
      expect(result.code, args.join(" ")).toBe(0)
      expect(result.stdout, args.join(" ")).toContain(expected)
      expect(result.stdout, args.join(" ")).not.toMatch(/(?:Usage|usage): kobe\b/)
    }
  })

  test("ROVE_HOME_DIR wins but still resolves the compatibility config path", () => {
    const originalLegacyHome = behavior.env.KOBE_HOME_DIR
    behavior.env.KOBE_HOME_DIR = join(behavior.home, "legacy-home")
    behavior.env.ROVE_HOME_DIR = join(behavior.home, "rove-home")
    try {
      const result = runRove(["config", "--path"], behavior)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe(join(behavior.home, "rove-home", ".config", "kobe", "state.json"))
    } finally {
      behavior.env.KOBE_HOME_DIR = originalLegacyHome
      Reflect.deleteProperty(behavior.env, "ROVE_HOME_DIR")
    }
  })

  test("the kobe compatibility alias installs ROVE_* precedence before loading the CLI", () => {
    const originalLegacyHome = behavior.env.KOBE_HOME_DIR
    behavior.env.KOBE_HOME_DIR = join(behavior.home, "legacy-home")
    behavior.env.ROVE_HOME_DIR = join(behavior.home, "rove-home")
    try {
      const result = runKobe(["config", "--path"], behavior)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe(join(behavior.home, "rove-home", ".config", "kobe", "state.json"))
    } finally {
      behavior.env.KOBE_HOME_DIR = originalLegacyHome
      Reflect.deleteProperty(behavior.env, "ROVE_HOME_DIR")
    }
  })
})
