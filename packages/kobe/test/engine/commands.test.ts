import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ClaudeCodeLocal } from "@/engine/claude-code-local"
import { CodexLocal } from "@/engine/codex-local"
import { extractFrontmatterField, scanSkillRoot } from "@/engine/command-discovery"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let tmpRoot: string
let fakeHome: string
let fakeCodexHome: string
let fakeWorktree: string
let savedHome: string | undefined
let savedCodexHome: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-engine-commands-"))
  fakeHome = path.join(tmpRoot, "home")
  fakeCodexHome = path.join(tmpRoot, "codex-home")
  fakeWorktree = path.join(tmpRoot, "repo", "subdir")
  fs.mkdirSync(fakeHome, { recursive: true })
  fs.mkdirSync(fakeCodexHome, { recursive: true })
  fs.mkdirSync(fakeWorktree, { recursive: true })
  savedHome = process.env.HOME
  savedCodexHome = process.env.CODEX_HOME
  process.env.HOME = fakeHome
  process.env.CODEX_HOME = fakeCodexHome
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: test cleanup must fully unset env keys when they were unset before the test.
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  // biome-ignore lint/performance/noDelete: test cleanup must fully unset env keys when they were unset before the test.
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function writeSkill(root: string, rel: string, name: string, description: string): void {
  const dir = path.join(root, rel)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Body\n`)
}

function writeClaudeCommand(root: string, name: string, description: string): void {
  const dir = path.join(root, ".claude", "commands")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n\nBody\n`)
}

describe("engine-owned command discovery", () => {
  test("frontmatter parsing anchors the closing delimiter to its own line", () => {
    const content = ["---", "name: dashed", "description: keep --- inside scalar", "---", "# Body"].join("\n")

    expect(extractFrontmatterField(content, "description")).toBe("keep --- inside scalar")
  })

  test("skill root scanning skips .system symlink cycles", async () => {
    const root = path.join(tmpRoot, "skills")
    writeSkill(root, "alpha", "alpha", "Alpha skill")
    fs.symlinkSync(root, path.join(root, ".system"), "dir")

    await expect(scanSkillRoot(root)).resolves.toEqual([
      {
        name: "alpha",
        description: "Alpha skill",
        path: path.join(root, "alpha", "SKILL.md"),
      },
    ])
  })

  test("Claude returns built-ins plus .claude project/user commands and skills", async () => {
    writeClaudeCommand(fakeHome, "deploy", "global deploy")
    writeSkill(fakeWorktree, ".claude/skills/autoplan", "autoplan", "project plan")

    const commands = await new ClaudeCodeLocal({ binaryPathResolver: async () => "claude" }).listCommands({
      cwd: fakeWorktree,
    })

    expect(commands.some((c) => c.display === "/compact" && c.source === "builtin")).toBe(true)
    expect(commands).toContainEqual({
      display: "/deploy",
      description: "global deploy",
      source: "user",
      kind: "slash",
    })
    expect(commands).toContainEqual({
      display: "/autoplan",
      description: "project plan",
      source: "project",
      kind: "skill",
    })
  })

  test("Codex returns Codex skills with dollar-invocation submit text and no Claude built-ins", async () => {
    writeSkill(fakeCodexHome, "skills/review-helper", "review-helper", "Review code")
    writeSkill(path.join(tmpRoot, "repo"), ".agents/skills/repo-plan", "repo-plan", "Plan repo work")
    writeSkill(fakeWorktree, ".codex/skills/local-fix", "local-fix", "Fix locally")

    const commands = await new CodexLocal({ binaryPathResolver: async () => "codex" }).listCommands({
      cwd: fakeWorktree,
    })

    expect(commands.some((c) => c.display === "/compact")).toBe(false)
    expect(commands).toContainEqual({
      display: "/review-helper",
      description: "Review code",
      source: "user",
      kind: "skill",
      submitText: "$review-helper",
    })
    expect(commands).toContainEqual({
      display: "/repo-plan",
      description: "Plan repo work",
      source: "project",
      kind: "skill",
      submitText: "$repo-plan",
    })
    expect(commands).toContainEqual({
      display: "/local-fix",
      description: "Fix locally",
      source: "project",
      kind: "skill",
      submitText: "$local-fix",
    })
  })

  test("Codex namespaces cached plugin skills with the plugin id", async () => {
    writeSkill(fakeCodexHome, "plugins/cache/chatgpt-global/linear/local/skills/triage", "triage", "Triage issues")

    const commands = await new CodexLocal({ binaryPathResolver: async () => "codex" }).listCommands({
      cwd: fakeWorktree,
    })

    expect(commands).toContainEqual({
      display: "/linear:triage",
      description: "Triage issues",
      source: "user",
      kind: "skill",
      submitText: "$linear:triage",
    })
  })
})
