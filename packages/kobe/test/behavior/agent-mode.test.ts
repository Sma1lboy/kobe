import { spawnSync } from "node:child_process"
import fs from "node:fs"
import * as net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import type { BackgroundAgent } from "../../src/types/engine"
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
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
  tmpRoot = null
})

test("workspace Agent mode lists Claude background agents for the active worktree", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-agent-mode-"))
  const homeDir = path.join(tmpRoot, "home")
  const repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)

  const kobeDir = path.join(homeDir, ".kobe")
  fs.mkdirSync(kobeDir, { recursive: true })
  fs.writeFileSync(
    path.join(kobeDir, "tasks.json"),
    `${JSON.stringify({
      version: 2,
      tasks: [
        {
          id: "01AGENTMODE",
          title: "agent mode smoke",
          repo,
          branch: "kobe/agent-mode",
          worktreePath: repo,
          kind: "task",
          sessionId: null,
          tabs: [
            {
              id: "tab-1",
              sessionId: null,
              seq: 1,
              vendor: "claude",
              createdAt: "2026-05-14T00:00:00.000Z",
            },
          ],
          activeTabId: "tab-1",
          status: "backlog",
          archived: false,
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    })}\n`,
    "utf8",
  )

  const port = await pickFreePort()
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })
  await kobe.waitFor((s) => s.includes("agent mode smoke"), 10_000)
  await waitForFakeServer(port)
  await postAgents(port, [
    {
      id: "job-1",
      sessionId: "session-agent-1",
      name: "check checkout failure",
      status: "running",
      sourceStatus: "running",
      cwd: repo,
      agent: "claude",
      jobId: "job-1",
      pid: 123,
      version: "2.1.141",
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  ])

  await kobe.sendKeys("\t") // sidebar -> workspace
  await kobe.sendKeys("\x07") // ctrl+g, chat.agents.toggle
  const screen = await kobe.waitFor((s) => s.includes("check checkout failure"), 10_000)
  expect(screen).toContain("WORKING")
  expect(screen).toContain("session-")
  expect(screen).toContain(repo)
})

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

async function waitForFakeServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await post(port, "/script", { sessionId: "__warmup__", events: [] })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`fake-engine server never came up on :${port}: ${lastErr}`)
}

async function postAgents(port: number, agents: BackgroundAgent[]): Promise<void> {
  await post(port, "/agents", { agents })
}

async function post(port: number, endpoint: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${await res.text()}`)
}
