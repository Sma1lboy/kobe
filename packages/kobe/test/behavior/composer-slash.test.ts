import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-init.sh")

let tmpRoot = ""
let kobe: KobeHandle | null = null

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
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = ""
})

test("Tab completes the highlighted slash command in the chat composer", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-slash-tab-"))
  const homeDir = path.join(tmpRoot, "home")
  const repo = path.join(tmpRoot, "repo")
  fs.mkdirSync(homeDir, { recursive: true })

  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
  await kobe.createTask(repo)
  await kobe.waitFor((s) => s.includes("main"), 10_000)

  await kobe.typeText("/comp")
  await kobe.waitFor((s) => s.includes("Clear conversation history"), 5_000)
  await kobe.sendKeys("\t")

  // The PTY screen normalizer preserves some cell-level repaint gaps,
  // so the completed `/compact` may surface as `/comp      act`.
  const screen = await kobe.waitFor((s) => />?\s*\/comp\s+act/.test(s), 5_000)
  expect(screen).toMatch(/>?\s*\/comp\s+act/)
}, 60_000)
