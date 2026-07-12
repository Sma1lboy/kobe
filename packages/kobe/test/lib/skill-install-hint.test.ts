/**
 * Companion to `skill-install.test.ts` for the halves that touch the real
 * environment: `maybeHintSkillInstall`'s one-shot stderr hints (persisted
 * flags in the shared state.json) and `kobeSkillState`'s unreadable-file
 * fallback. `node:os.homedir` is mocked to a temp dir (the dev machine has
 * the real skill installed — the default lookup must not see it) and
 * `process.cwd` is spied per test.
 */

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
let originalStdinIsTTY: boolean | undefined

function skillDir(root: string): string {
  return join(root, ".claude/skills/kobe")
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "kobe-skillhint-cwd-"))
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  // Persisted hint flags land in a fresh state.json per test.
  originalKobeHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-skillhint-state-"))
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  // Force the non-interactive path unless a test injects `ask` (a TTY test
  // runner would otherwise flip maybeHintSkillInstall into prompt mode).
  originalStdinIsTTY = process.stdin.isTTY
  process.stdin.isTTY = false
})

afterEach(() => {
  const stateHome = process.env.KOBE_HOME_DIR
  if (originalKobeHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalKobeHome
  vi.restoreAllMocks()
  process.stdin.isTTY = originalStdinIsTTY as boolean
  rmSync(cwd, { recursive: true, force: true })
  if (stateHome) rmSync(stateHome, { recursive: true, force: true })
  rmSync(skillDir(tmpHome), { recursive: true, force: true })
})

describe("kobeSkillState — unreadable install", () => {
  it("treats an existing-but-unreadable SKILL.md as unstamped (stale)", () => {
    // SKILL.md as a DIRECTORY: existsSync says yes, readFileSync throws EISDIR.
    mkdirSync(join(skillDir(cwd), "SKILL.md"), { recursive: true })
    expect(kobeSkillState({ home: tmpHome, cwd })).toMatchObject({
      installed: true,
      installedVersion: null,
      stale: true,
    })
  })
})

function writeStaleSkill(): void {
  mkdirSync(skillDir(cwd), { recursive: true })
  writeFileSync(join(skillDir(cwd), "SKILL.md"), `<!-- kobe-skill-version: ${KOBE_SKILL_VERSION - 1} -->`)
}

const muteKey = `skillHintSeen:v${KOBE_SKILL_VERSION}`

describe("maybeHintSkillInstall", () => {
  it("absent skill: hints exactly once, then persists the flag and stays quiet", async () => {
    await maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("kobe skill install")
    expect(getPersistedString("skillHintSeen")).toBe("1")

    await maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it("fresh skill: no hint at all", async () => {
    mkdirSync(skillDir(cwd), { recursive: true })
    writeFileSync(join(skillDir(cwd), "SKILL.md"), `<!-- kobe-skill-version: ${KOBE_SKILL_VERSION} -->`)
    await maybeHintSkillInstall()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it("stale + non-TTY: hints once per skill version, naming the installed version", async () => {
    writeStaleSkill()

    await maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = String(stderrSpy.mock.calls[0]?.[0])
    expect(msg).toContain(`v${KOBE_SKILL_VERSION - 1}`)
    expect(msg).toContain(`v${KOBE_SKILL_VERSION}`)
    expect(getPersistedString(muteKey)).toBe("1")

    await maybeHintSkillInstall()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it("unstamped install: hinted as 'an older' version", async () => {
    mkdirSync(skillDir(cwd), { recursive: true })
    writeFileSync(join(skillDir(cwd), "SKILL.md"), "no marker")
    await maybeHintSkillInstall()
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("an older")
  })

  it("stale + interactive 'y': runs the install, nothing persisted", async () => {
    writeStaleSkill()
    let ran = 0
    const install = async () => {
      ran++
      return 0
    }
    await maybeHintSkillInstall({ ask: async () => "y\n", install })
    expect(ran).toBe(1)
    expect(getPersistedString(muteKey)).toBeUndefined()
    expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain("updated")
  })

  it("stale + interactive 'n': asks again next launch", async () => {
    writeStaleSkill()
    let ran = 0
    const install = async () => {
      ran++
      return 0
    }
    await maybeHintSkillInstall({ ask: async () => "n\n", install })
    expect(ran).toBe(0)
    expect(getPersistedString(muteKey)).toBeUndefined()

    await maybeHintSkillInstall({ ask: async () => "n\n", install })
    expect(stderrSpy).toHaveBeenCalledTimes(2) // prompted both launches
  })

  it("stale + interactive 'd': mutes this skill version", async () => {
    writeStaleSkill()
    await maybeHintSkillInstall({ ask: async () => "d\n", install: async () => 0 })
    expect(getPersistedString(muteKey)).toBe("1")

    await maybeHintSkillInstall({ ask: async () => "d\n", install: async () => 0 })
    expect(stderrSpy).toHaveBeenCalledTimes(1) // no second prompt
  })

  it("stale + interactive 'y' with failing install: not muted, retries next launch", async () => {
    writeStaleSkill()
    await maybeHintSkillInstall({ ask: async () => "yes\n", install: async () => 1 })
    expect(getPersistedString(muteKey)).toBeUndefined()
    expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain("failed")
  })
})
