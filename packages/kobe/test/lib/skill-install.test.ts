import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SKILL_AGENT,
  KOBE_SKILL_VERSION,
  SKILL_INSTALL_COMMAND,
  isKobeSkillInstalled,
  kobeSkillPaths,
  kobeSkillState,
  npxSkillsArgv,
  npxSkillsCommand,
  parseSkillVersion,
} from "../../src/lib/skill-install.ts"

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kobe-skill-"))
  dirs.push(d)
  return d
}
function installSkillUnder(root: string, body = "skill"): void {
  mkdirSync(join(root, ".claude/skills/kobe"), { recursive: true })
  writeFileSync(join(root, ".claude/skills/kobe/SKILL.md"), body)
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

describe("skill version / staleness", () => {
  it("parses the kobe-skill-version marker", () => {
    expect(parseSkillVersion("<!-- kobe-skill-version: 3 -->\n# x")).toBe(3)
    expect(parseSkillVersion("no marker here")).toBeNull()
  })

  it("the repo SKILL.md marker is in lockstep with KOBE_SKILL_VERSION", () => {
    // The whole staleness mechanism hinges on these two agreeing — guard it.
    const repoSkill = join(dirname(fileURLToPath(import.meta.url)), "../../../../.agents/skills/kobe/SKILL.md")
    expect(parseSkillVersion(readFileSync(repoSkill, "utf8"))).toBe(KOBE_SKILL_VERSION)
  })

  it("kobeSkillState: absent → not installed, not stale", () => {
    const s = kobeSkillState({ home: tempDir(), cwd: tempDir() })
    expect(s).toMatchObject({ installed: false, stale: false })
  })

  it("kobeSkillState: current version → fresh", () => {
    const cwd = tempDir()
    installSkillUnder(cwd, `<!-- kobe-skill-version: ${KOBE_SKILL_VERSION} -->`)
    expect(kobeSkillState({ home: tempDir(), cwd })).toMatchObject({ installed: true, stale: false })
  })

  it("kobeSkillState: older version → stale", () => {
    const cwd = tempDir()
    installSkillUnder(cwd, `<!-- kobe-skill-version: ${KOBE_SKILL_VERSION - 1} -->`)
    expect(kobeSkillState({ home: tempDir(), cwd })).toMatchObject({
      installed: true,
      installedVersion: KOBE_SKILL_VERSION - 1,
      stale: true,
    })
  })

  it("kobeSkillState: unstamped install → stale (refresh once)", () => {
    const cwd = tempDir()
    installSkillUnder(cwd, "old skill with no version marker")
    expect(kobeSkillState({ home: tempDir(), cwd })).toMatchObject({
      installed: true,
      installedVersion: null,
      stale: true,
    })
  })
})
