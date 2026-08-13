import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  KOBE_SKILL_VERSION,
  bundledSkillDir,
  isKobeSkillInstalled,
  kobeSkillPaths,
  kobeSkillState,
  npxSkillsArgv,
  npxSkillsCommand,
  parseSkillVersion,
  skillInstallCommand,
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
  it("covers .agents (where the CLI writes the real file) and .claude, home + project", () => {
    // The agent-skills CLI puts the real SKILL.md in .agents/skills and
    // symlinks agent dirs at it. Looking only under .claude reported "not
    // installed" for a perfectly good install.
    expect(kobeSkillPaths({ home: "/h", cwd: "/p" })).toEqual([
      "/h/.agents/skills/kobe/SKILL.md",
      "/h/.claude/skills/kobe/SKILL.md",
      "/p/.agents/skills/kobe/SKILL.md",
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

describe("npxSkillsArgv / npxSkillsCommand", () => {
  it("names NO agent by default — the agent-skills CLI detects and asks", () => {
    // kobe deliberately owns no agent registry: ~75 agents, each with its own
    // skills dir and symlink rules. Passing an agent here would freeze that
    // list into kobe.
    expect(npxSkillsArgv({ source: "/bundled" })).toEqual(["skills", "add", "/bundled", "--skill", "kobe", "--global"])
    expect(npxSkillsArgv({ source: "/bundled" })).not.toContain("--agent")
  })

  it("installs GLOBAL by default; global:false opts into project-level", () => {
    // The skill drives a machine-wide daemon — one user-level copy, one
    // staleness lifecycle, instead of a re-prompt in every repo.
    expect(npxSkillsArgv({ source: "/b" })).toContain("--global")
    expect(npxSkillsArgv({ source: "/b", global: false })).not.toContain("--global")
  })

  it("installs from the BUNDLED path, not a repo clone", () => {
    // `npx skills add Sma1lboy/kobe` is a `git clone --depth 1` = ~198MB of
    // working tree for an 8KB file. The local path skips the network.
    const dir = bundledSkillDir()
    expect(dir).not.toBeNull()
    expect(npxSkillsArgv()[2]).toBe(dir)
  })

  it("falls back to the repo slug when nothing is bundled", () => {
    expect(npxSkillsArgv({ source: null })).toContain("Sma1lboy/kobe")
  })

  it("repeats --agent per agent (the CLI rejects a comma-joined list)", () => {
    expect(npxSkillsArgv({ source: "/b", agent: "cursor" })).toEqual([
      "skills",
      "add",
      "/b",
      "--skill",
      "kobe",
      "--global",
      "--agent",
      "cursor",
    ])
    expect(npxSkillsCommand({ source: "/b", agent: ["claude-code", "codex"] })).toBe(
      "npx skills add /b --skill kobe --global --agent claude-code --agent codex",
    )
  })
})

describe("skillInstallCommand", () => {
  it("follows the invoked canonical or compatibility entry", () => {
    expect(skillInstallCommand({ ROVE_INVOKED_AS: "rove" })).toBe("rove skill install")
    expect(skillInstallCommand({ ROVE_INVOKED_AS: "kobe" })).toBe("kobe skill install")
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
