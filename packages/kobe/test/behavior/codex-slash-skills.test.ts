/**
 * Behavior test — Codex tabs surface Codex skills in the slash dropdown.
 *
 * The regression this guards is product-visible: the composer used to
 * render Claude Code slash commands for every tab, so a Codex tab either
 * showed misleading Claude-only commands or nothing useful. We seed a
 * Codex-pinned task plus a local Codex skill, open `/`, and assert the
 * dropdown contains the Codex skill while omitting a Claude-only command.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-init.sh")

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

beforeAll(() => {
  if (!fs.existsSync(REPO_INIT)) throw new Error(`missing fixture: ${REPO_INIT}`)
})

afterEach(async () => {
  if (kobe && !kobe.closed) await kobe.exit()
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
  tmpRoot = null
})

function writeCodexSkill(codexHome: string, name: string, description: string): void {
  const dir = path.join(codexHome, "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Body\n`)
}

function seedCodexTask(homeDir: string, repo: string): void {
  const now = "2026-05-17T00:00:00.000Z"
  const kobeDir = path.join(homeDir, ".kobe")
  fs.mkdirSync(kobeDir, { recursive: true })
  fs.writeFileSync(
    path.join(kobeDir, "tasks.json"),
    `${JSON.stringify({
      version: 2,
      tasks: [
        {
          id: "01KOBECODEXSLASH000000000",
          title: "codex slash smoke",
          repo,
          branch: "kobe/codex-slash",
          worktreePath: repo,
          kind: "task",
          sessionId: null,
          tabs: [
            {
              id: "tab-codex",
              sessionId: null,
              seq: 1,
              vendor: "codex",
              model: "gpt-5.5",
              modelEffort: "medium",
              createdAt: now,
            },
          ],
          activeTabId: "tab-codex",
          status: "in_progress",
          archived: false,
          vendor: "codex",
          model: "gpt-5.5",
          modelEffort: "medium",
          createdAt: now,
          updatedAt: now,
        },
      ],
    })}\n`,
    "utf8",
  )
}

test("Codex slash dropdown shows Codex skills instead of Claude built-ins", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-codex-slash-"))
  const homeDir = path.join(tmpRoot, "home")
  const codexHome = path.join(tmpRoot, "codex-home")
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  const repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)

  writeCodexSkill(codexHome, "review-helper", "Review code with Codex")
  seedCodexTask(homeDir, repo)

  kobe = await spawnKobe({
    env: {
      HOME: homeDir,
      CODEX_HOME: codexHome,
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
    settleMs: 150,
  })
  await kobe.waitFor((s) => s.includes("codex slash smoke"), 10_000)

  await kobe.sendKeys("\t") // Move focus from TASKS to WORKSPACE.
  await kobe.waitFor((s) => s.includes("Ask Codex"), 5_000)
  await kobe.typeText("/")
  const screen = await kobe.waitFor((s) => s.includes("/review-helper"), 10_000)

  expect(screen).toContain("/review-helper")
  expect(screen).toContain("Review code with Codex")
  expect(screen).not.toContain("/compact")
}, 30_000)
