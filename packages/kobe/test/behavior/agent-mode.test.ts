import { spawnSync } from "node:child_process"
import fs from "node:fs"
import * as net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import type { BackgroundAgent, Message } from "../../src/types/engine"
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
  expect(screen).toContain("running")
  expect(screen).not.toContain("session-agent-1")
  expect(screen).not.toContain(repo)
})

test("workspace Agent mode shows all product-facing background states", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-agent-mode-states-"))
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
          id: "01AGENTSTATES",
          title: "agent states smoke",
          repo,
          branch: "kobe/agent-states",
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
    rows: 36,
  })
  await kobe.waitFor((s) => s.includes("agent states smoke"), 10_000)
  await waitForFakeServer(port)
  await postAgents(port, [
    backgroundAgent("working checkout", "running", repo, 60),
    backgroundAgent("answer question", "blocked", repo, 50),
    backgroundAgent("ready for prompt", "idle", repo, 40),
    backgroundAgent("finished task", "completed", repo, 30),
    backgroundAgent("hit error", "failed", repo, 20),
    backgroundAgent("stopped manually", "stopped", repo, 10),
  ])

  await kobe.sendKeys("\t") // sidebar -> workspace
  await kobe.sendKeys("\x07") // ctrl+g, chat.agents.toggle
  const screen = await kobe.waitFor((s) => s.includes("stopped manually") && s.includes("STOPPED"), 10_000)
  expect(screen).toContain("WORKING")
  expect(screen).toContain("NEEDS INPUT")
  expect(screen).toContain("IDLE")
  expect(screen).toContain("COMPLETED")
  expect(screen).toContain("FAILED")
  expect(screen).toContain("STOPPED")
})

test("workspace Agent mode can start a Claude background agent from a prompt", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-agent-mode-start-"))
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
          id: "01AGENTSTART",
          title: "agent start smoke",
          repo,
          branch: "kobe/agent-start",
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
  await kobe.waitFor((s) => s.includes("agent start smoke"), 10_000)
  await waitForFakeServer(port)

  await kobe.sendKeys("\t") // sidebar -> workspace
  await kobe.sendKeys("\x07") // ctrl+g, chat.agents.toggle
  await kobe.waitFor((s) => s.includes("Start a background agent"), 10_000)
  await kobe.typeText("write customer greeting")
  await kobe.sendKeys("\r")

  const screen = await kobe.waitFor((s) => s.includes("write customer greeting") && s.includes("IDLE"), 10_000)
  expect(screen).toContain("IDLE")
  expect(screen).toContain("idle")
  expect(screen).not.toContain(repo)
}, 20_000)

test("workspace Agent mode opens a background agent session on row click", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-agent-mode-open-"))
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
          id: "01AGENTOPEN",
          title: "agent open smoke",
          repo,
          branch: "kobe/agent-open",
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
  await kobe.waitFor((s) => s.includes("agent open smoke"), 10_000)
  await waitForFakeServer(port)
  await postAgents(port, [
    {
      id: "job-open",
      sessionId: "session-agent-open",
      name: "inspect failing checkout",
      status: "running",
      sourceStatus: "running",
      cwd: repo,
      agent: "claude",
      jobId: "job-open",
      pid: 456,
      version: "2.1.141",
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  ])
  await postHistory(port, "session-agent-open", [
    {
      role: "user",
      blocks: [{ type: "text", text: "inspect failing checkout" }],
      timestamp: "2026-05-14T00:00:00.000Z",
      sessionId: "session-agent-open",
    },
    {
      role: "assistant",
      blocks: [{ type: "text", text: "background agent is checking the failing checkout now" }],
      timestamp: "2026-05-14T00:00:01.000Z",
      sessionId: "session-agent-open",
    },
  ])

  await kobe.sendKeys("\t") // sidebar -> workspace
  await kobe.sendKeys("\x07") // ctrl+g, chat.agents.toggle
  await kobe.waitFor((s) => s.includes("inspect failing checkout"), 10_000)
  await kobe.click(48, 10)
  const screen = await kobe.waitFor((s) => s.includes("background agent is checking the failing checkout now"), 10_000)
  expect(screen).toContain("Chat")
  expect(screen).toContain("background agent is checking the failing checkout now")
}, 20_000)

test("workspace Agent mode opens a blocked background question in the Chat interface", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-agent-mode-question-"))
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
          id: "01AGENTQUESTION",
          title: "agent question smoke",
          repo,
          branch: "kobe/agent-question",
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
    rows: 34,
  })
  await kobe.waitFor((s) => s.includes("agent question smoke"), 10_000)
  await waitForFakeServer(port)
  await postAgents(port, [
    {
      id: "job-question",
      sessionId: "session-agent-question",
      name: "choose date library",
      status: "blocked",
      sourceStatus: "needs_input",
      cwd: repo,
      agent: "claude",
      jobId: "job-question",
      pid: 456,
      version: "2.1.141",
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
  ])
  await postHistory(port, "session-agent-question", [
    {
      role: "user",
      blocks: [{ type: "text", text: "use ask user question to ask me question" }],
      timestamp: "2026-05-14T00:00:00.000Z",
      sessionId: "session-agent-question",
    },
  ])

  await kobe.sendKeys("\t") // sidebar -> workspace
  await kobe.sendKeys("\x07") // ctrl+g, chat.agents.toggle
  await kobe.waitFor((s) => s.includes("choose date library"), 10_000)
  await kobe.click(48, 10)
  await postHistory(port, "session-agent-question", [
    {
      role: "user",
      blocks: [{ type: "text", text: "use ask user question to ask me question" }],
      timestamp: "2026-05-14T00:00:00.000Z",
      sessionId: "session-agent-question",
    },
    {
      role: "assistant",
      blocks: [
        {
          type: "tool_call",
          callId: "toolu_question",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which library should the background agent use?",
                header: "Library",
                multiSelect: false,
                options: [
                  { label: "date-fns", description: "Small and functional" },
                  { label: "luxon", description: "Class-based dates" },
                ],
              },
            ],
          },
        },
      ],
      timestamp: "2026-05-14T00:00:01.000Z",
      sessionId: "session-agent-question",
    },
  ])
  await kobe.waitFor(
    (s) =>
      s.includes("Awaiting your answer") &&
      s.includes("background") &&
      s.includes("agent use?") &&
      s.includes("date-fns"),
    10_000,
  )

  await post(port, "/respond", {
    kind: "ask_question",
    answers: { "Which library should the background agent use?": "date-fns" },
  })
  const screen = await kobe.waitFor((s) => s.includes("date-fns") && s.includes("Please continue."), 10_000)
  expect(screen).toContain("Which library should the background agent use?")
}, 20_000)

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

async function postHistory(port: number, sessionId: string, messages: Message[]): Promise<void> {
  await post(port, "/history", { sessionId, messages })
}

function backgroundAgent(
  name: string,
  status: BackgroundAgent["status"],
  cwd: string,
  updatedAtMs: number,
): BackgroundAgent {
  const id = name.replace(/\s+/g, "-")
  return {
    id,
    sessionId: `session-${id}`,
    name,
    status,
    sourceStatus: status,
    cwd,
    agent: "claude",
    jobId: id,
    pid: null,
    version: "fake",
    startedAtMs: updatedAtMs,
    updatedAtMs,
  }
}

async function post(port: number, endpoint: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${await res.text()}`)
}
