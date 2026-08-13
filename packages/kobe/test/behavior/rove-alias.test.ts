import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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

  test("ROVE_HOME_DIR wins and resolves the canonical config path", () => {
    const originalLegacyHome = behavior.env.KOBE_HOME_DIR
    behavior.env.KOBE_HOME_DIR = join(behavior.home, "legacy-home")
    behavior.env.ROVE_HOME_DIR = join(behavior.home, "rove-home")
    try {
      const result = runRove(["config", "--path"], behavior)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe(join(behavior.home, "rove-home", ".config", "rove", "state.json"))
    } finally {
      behavior.env.KOBE_HOME_DIR = originalLegacyHome
      Reflect.deleteProperty(behavior.env, "ROVE_HOME_DIR")
    }
  })

  test("the public wrapper migrates client state without racing daemon-owned stores", () => {
    const originalLegacyHome = behavior.env.KOBE_HOME_DIR
    const migrationHome = join(behavior.home, "migration-home")
    behavior.env.KOBE_HOME_DIR = migrationHome
    mkdirSync(join(migrationHome, ".kobe"), { recursive: true })
    mkdirSync(join(migrationHome, ".config", "kobe"), { recursive: true })
    mkdirSync(join(migrationHome, ".rove"), { recursive: true })
    mkdirSync(join(migrationHome, ".kobe", "settings"), { recursive: true })
    writeFileSync(join(migrationHome, ".kobe", "settings", "keybindings.yaml"), "legacy keys")
    writeFileSync(join(migrationHome, ".kobe", "tasks.json"), "daemon tasks")
    writeFileSync(join(migrationHome, ".config", "kobe", "state.json"), "legacy prefs")
    writeFileSync(join(migrationHome, ".rove", "issues.json"), "canonical issues")
    writeFileSync(join(migrationHome, ".kobe", "issues.json"), "legacy issues")
    try {
      const result = runRove(["config", "--path"], behavior)
      expect(result.code).toBe(0)
      expect(readFileSync(join(migrationHome, ".rove", "settings", "keybindings.yaml"), "utf8")).toBe("legacy keys")
      expect(readFileSync(join(migrationHome, ".config", "rove", "state.json"), "utf8")).toBe("legacy prefs")
      expect(readFileSync(join(migrationHome, ".rove", "issues.json"), "utf8")).toBe("canonical issues")
      expect(existsSync(join(migrationHome, ".rove", "tasks.json"))).toBe(false)
      expect(existsSync(join(migrationHome, ".rove", "worktrees"))).toBe(false)
    } finally {
      behavior.env.KOBE_HOME_DIR = originalLegacyHome
    }
  })

  test("the kobe compatibility alias installs ROVE_* precedence before loading the CLI", () => {
    const originalLegacyHome = behavior.env.KOBE_HOME_DIR
    behavior.env.KOBE_HOME_DIR = join(behavior.home, "legacy-home")
    behavior.env.ROVE_HOME_DIR = join(behavior.home, "rove-home")
    try {
      const result = runKobe(["config", "--path"], behavior)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe(join(behavior.home, "rove-home", ".config", "rove", "state.json"))
    } finally {
      behavior.env.KOBE_HOME_DIR = originalLegacyHome
      Reflect.deleteProperty(behavior.env, "ROVE_HOME_DIR")
    }
  })
})
