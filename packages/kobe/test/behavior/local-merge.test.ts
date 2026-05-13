/**
 * Behavior test for the sidebar M local-merge flow.
 *
 * The visible product contract is: a selected task can start a local merge
 * without leaving kobe; kobe creates a Merge chat tab and injects a prompt
 * that targets the parent repo checkout, not the PR flow.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import * as net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import type { EngineEvent } from "../../src/types/engine.ts"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-init.sh")

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error("could not allocate a free port"))
      }
    })
  })
}

async function scriptEngine(
  port: number,
  endpoint: "/script" | "/finish",
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload)
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${text}`)
  }
}

async function triggerLocalMerge(port: number, timeoutMs = 15_000): Promise<{ taskId: string; prompt: string }> {
  const deadline = Date.now() + timeoutMs
  let lastErr = "(no attempts yet)"
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: "{}",
    })
    if (res.ok) return (await res.json()) as { taskId: string; prompt: string }
    lastErr = `${res.status} ${await res.text()}`
    if (res.status !== 503) throw new Error(`fake-engine /merge failed: ${lastErr}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`fake-engine /merge timed out (last: ${lastErr})`)
}

async function waitForFakeServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await scriptEngine(port, "/script", { sessionId: "__warmup__", events: [] })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`fake-engine server never came up on :${port}: ${lastErr}`)
}

async function buildFixture(): Promise<{ tmpRoot: string; homeDir: string; repo: string; taskTitle: string }> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-local-merge-"))
  const homeDir = path.join(tmpRoot, "home")
  const kobeDir = path.join(homeDir, ".kobe")
  fs.mkdirSync(kobeDir, { recursive: true })
  const repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  const worktreePath = path.join(tmpRoot, "task-worktree")
  const wt = spawnSync("git", ["worktree", "add", "-b", "kobe/merge-smoke", worktreePath, "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  })
  if (wt.status !== 0) throw new Error(`git worktree add failed: ${wt.stderr}\n${wt.stdout}`)
  const now = new Date().toISOString()
  const taskTitle = "merge smoke"
  fs.writeFileSync(
    path.join(kobeDir, "tasks.json"),
    JSON.stringify(
      {
        version: 2,
        tasks: [
          {
            id: "01KOBELOCALMERGE0000000000",
            title: taskTitle,
            repo,
            branch: "kobe/merge-smoke",
            worktreePath,
            kind: "task",
            sessionId: null,
            tabs: [{ id: "tab-main", sessionId: null, seq: 1, createdAt: now }],
            activeTabId: "tab-main",
            status: "done",
            archived: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2,
    ),
  )
  return { tmpRoot, homeDir, repo, taskTitle }
}

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

beforeAll(() => {
  if (!fs.existsSync(REPO_INIT)) throw new Error(`missing fixture: ${REPO_INIT}`)
})

afterEach(async () => {
  if (kobe && !kobe.closed) await kobe.exit()
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = null
})

test("M local merge injects a Merge-tab prompt for the parent repo checkout", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
    },
    cols: 200,
    rows: 60,
  })

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
  await waitForFakeServer(port)

  await kobe.waitFor((s) => s.includes(fixture.taskTitle), 10_000)
  await kobe.sendKeys("\r")
  await kobe.waitFor((s) => s.includes("WORKSPACE") && s.includes(fixture.taskTitle), 10_000)

  const { prompt } = await triggerLocalMerge(port)

  expect(prompt).toContain("LOCAL MERGE, not PR")
  expect(prompt).toContain("Target parent repo checkout:")
  expect(prompt).toContain(fixture.repo)
  expect(prompt).toContain("Do not create a pull request.")
  expect(prompt).not.toContain("Follow these steps to create a PR")

  await kobe.waitFor((s) => s.includes("LOCAL MERGE, not PR"), 10_000)
  await kobe.waitFor((s) => s.includes("Merge"), 10_000)

  await kobe.exit()
}, 90_000)
