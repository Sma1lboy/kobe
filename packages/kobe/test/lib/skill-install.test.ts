import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SKILL_AGENT,
  SKILL_INSTALL_COMMAND,
  isKobeSkillInstalled,
  kobeSkillPaths,
  npxSkillsArgv,
  npxSkillsCommand,
} from "../../src/lib/skill-install.ts"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kobe-skill-"))
  dirs.push(d)
  return d
}
function installSkillUnder(root: string): void {
  mkdirSync(join(root, ".claude/skills/kobe"), { recursive: true })
  writeFileSync(join(root, ".claude/skills/kobe/SKILL.md"), "skill")
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("kobeSkillPaths", () => {
  it("returns the user-home and project-level skill paths", () => {
    expect(kobeSkillPaths({ home: "/h", cwd: "/p" })).toEqual([
      "/h/.claude/skills/kobe/SKILL.md",
      "/p/.claude/skills/kobe/SKILL.md",
    ])
  })
})

describe("isKobeSkillInstalled", () => {
  it("is false when neither location has the skill", () => {
    expect(isKobeSkillInstalled({ home: tempDir(), cwd: tempDir() })).toBe(false)
  })

  it("is true when the project-level skill exists", () => {
    const cwd = tempDir()
    installSkillUnder(cwd)
    expect(isKobeSkillInstalled({ home: tempDir(), cwd })).toBe(true)
  })

  it("is true when the user-home skill exists", () => {
    const home = tempDir()
    installSkillUnder(home)
    expect(isKobeSkillInstalled({ home, cwd: tempDir() })).toBe(true)
  })
})

describe("SKILL_INSTALL_COMMAND", () => {
  it("is kobe's user-facing wrapper command", () => {
    expect(SKILL_INSTALL_COMMAND).toBe("kobe skill install")
  })
})

describe("npxSkillsArgv / npxSkillsCommand", () => {
  it("wraps `npx skills add Sma1lboy/kobe` with the default agent", () => {
    expect(npxSkillsArgv()).toEqual([
      "skills",
      "add",
      "Sma1lboy/kobe",
      "--skill",
      "kobe",
      "--agent",
      DEFAULT_SKILL_AGENT,
    ])
    expect(npxSkillsCommand()).toBe(`npx skills add Sma1lboy/kobe --skill kobe --agent ${DEFAULT_SKILL_AGENT}`)
  })

  it("lets the caller override the agent", () => {
    expect(npxSkillsArgv({ agent: "cursor" })).toContain("cursor")
    expect(npxSkillsCommand({ agent: "cursor" })).toContain("--agent cursor")
  })
})
