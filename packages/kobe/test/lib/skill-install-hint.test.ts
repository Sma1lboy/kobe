import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tmpHome = mkdtempSync(join(tmpdir(), "kobe-skillhint-home-"))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } }
})

import { KOBE_SKILL_VERSION, kobeSkillState, maybeHintSkillInstall } from "../../src/lib/skill-install.ts"
import { getPersistedString } from "../../src/state/repos.ts"

let cwd: string
let originalKobeHome: string | undefined
let stderrSpy: MockInstance

function skillDir(root: string): string {
  return join(root, ".claude/skills/kobe")
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kobe-skillhint-cwd-"))
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  originalKobeHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-skillhint-state-"))
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
})

afterEach(() => {
  const stateHome = process.env.KOBE_HOME_DIR
  if (originalKobeHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalKobeHome
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
  if (stateHome) rmSync(stateHome, { recursive: true, force: true })
  rmSync(skillDir(tmpHome), { recursive: true, force: true })
})

describe("kobeSkillState — unreadable install", () => {
  it("treats an existing-but-unreadable SKILL.md as unstamped (stale)", () => {
    mkdirSync(join(skillDir(cwd), "SKILL.md"), { recursive: true })
    expect(kobeSkillState({ home: tmpHome, cwd })).toMatchObject({
      installed: true,
      installedVersion: null,
      stale: true,
    })
  })
})

describe("maybeHintSkillInstall", () => {
  it("absent skill: hints exactly once, then persists the flag and stays quiet", () => {
    maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("kobe skill install")
    expect(getPersistedString("skillHintSeen")).toBe("1")

    maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it("fresh skill: no hint at all", () => {
    mkdirSync(skillDir(cwd), { recursive: true })
    writeFileSync(join(skillDir(cwd), "SKILL.md"), `<!-- kobe-skill-version: ${KOBE_SKILL_VERSION} -->`)
    maybeHintSkillInstall()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it("stale skill: hints once per skill version, naming the installed version", () => {
    mkdirSync(skillDir(cwd), { recursive: true })
    writeFileSync(join(skillDir(cwd), "SKILL.md"), `<!-- kobe-skill-version: ${KOBE_SKILL_VERSION - 1} -->`)

    maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = String(stderrSpy.mock.calls[0]?.[0])
    expect(msg).toContain(`v${KOBE_SKILL_VERSION - 1}`)
    expect(msg).toContain(`v${KOBE_SKILL_VERSION}`)
    expect(getPersistedString(`skillHintSeen:v${KOBE_SKILL_VERSION}`)).toBe("1")

    maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it("unstamped install: hinted as 'an older' version", () => {
    mkdirSync(skillDir(cwd), { recursive: true })
    writeFileSync(join(skillDir(cwd), "SKILL.md"), "no marker")
    maybeHintSkillInstall()
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("an older")
  })
})
