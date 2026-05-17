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
  if (!fs.existsSync(REPO_INIT)) {
    throw new Error(`missing fixture: ${REPO_INIT}`)
  }
})

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
  tmpRoot = null
})

test("top bar hides the active chat tab session id", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-topbar-sid-"))
  const homeDir = path.join(tmpRoot, "home")
  const repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }

  const kobeDir = path.join(homeDir, ".kobe")
  fs.mkdirSync(kobeDir, { recursive: true })
  fs.writeFileSync(
    path.join(kobeDir, "tasks.json"),
    `${JSON.stringify({
      version: 2,
      tasks: [
        {
          id: "01TOPBARSID",
          title: "session id smoke",
          repo,
          branch: "kobe/session-id",
          worktreePath: repo,
          kind: "task",
          sessionId: "fake-1",
          tabs: [{ id: "tab-1", sessionId: "fake-1", seq: 1, createdAt: "2026-05-12T00:00:00.000Z" }],
          activeTabId: "tab-1",
          status: "in_progress",
          archived: false,
          createdAt: "2026-05-12T00:00:00.000Z",
          updatedAt: "2026-05-12T00:00:00.000Z",
        },
      ],
    })}\n`,
    "utf8",
  )

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  const screen = await kobe.waitFor((s) => s.includes("kobe/session-id"), 10_000)
  expect(screen).toContain("kobe/session-id")
  expect(screen).not.toContain("sid fake-1")
})
