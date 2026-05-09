/**
 * Gate G2 — single-task chat demo behavior test.
 *
 * This is the load-bearing self-validation for Wave 2. The agent runs
 * the real kobe binary in a PTY, drives it like a user (key by key),
 * scripts the engine via the HTTP side-channel, and asserts visible
 * behavior on the captured screen.
 *
 * Why this test exists:
 *   - Per HARNESS.md §Behavioral self-test, every user-visible feature
 *     must be self-tested by running the actual binary, not just by
 *     invoking the orchestrator API. Without this we'd ship Wave 2
 *     having proven the orchestrator works in vitro and find at merge
 *     that the App layout never wired Sidebar to Orchestrator.
 *
 *   - This is also the first behavioral test that exercises the *whole
 *     stack*: TUI shell → orchestrator → engine. If a single seam
 *     between Wave 1 and Wave 2 is broken, this test catches it.
 *
 * Side-channel mechanism (documented here AND in `src/tui/app.tsx`):
 *
 *   When `KOBE_TEST_ENGINE=fake`, kobe instantiates `FakeAIEngine`
 *   instead of `ClaudeCodeLocal`. To script events into that fake from
 *   *outside* the kobe child process (the test runs in vitest's
 *   process; kobe runs in a PTY child), we expose a tiny HTTP server
 *   inside kobe on a port that the test pre-allocates and passes via
 *   `KOBE_TEST_FAKE_PORT`. The test POSTs scripted events to it.
 *
 *   - Picking a port: we open a `net.Server`, read its assigned port,
 *     close it, then use that port. Quick race window but acceptable
 *     for a dev test.
 *   - Endpoints: `POST /script {sessionId, events}` and
 *     `POST /finish {sessionId}`. See `src/tui/app.tsx` mountFakeEngineServer.
 *
 *   This sidesteps the complication of "FakeAIEngine on globalThis"
 *   which only works in-process. HTTP is cross-process by definition
 *   and adds zero deps (Node's `node:http` ships with Bun).
 *
 * Test flow (mirrors the brief):
 *   1. Build a fixture git repo (so `worktrees.createForTask` succeeds).
 *   2. Start kobe with KOBE_TEST_ENGINE=fake + KOBE_TEST_FAKE_PORT=<port>
 *      + KOBE_HOME_DIR=<tmpdir>.
 *   3. Press `n`, fill in title + repo, submit. Wait for "demo task" in
 *      the sidebar.
 *   4. Press enter to submit a chat prompt (the task is already selected
 *      because the new-task creator auto-selects it).
 *   5. Script the FakeAIEngine via HTTP to emit assistant deltas.
 *   6. Wait for the deltas to render in the chat pane.
 *   7. Exit cleanly.
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

/** Pick an unused TCP port by binding+closing — small race window, fine for tests. */
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

/** POST JSON to the kobe fake-engine server. */
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

/** Wait until the kobe HTTP side-channel is ready; otherwise the first POST 500s. */
async function waitForFakeServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      // POST a no-op script that doesn't bind to a real session — server
      // accepts any sessionId and just queues events. We use a sentinel
      // sessionId to avoid colliding with a real one.
      await scriptEngine(port, "/script", { sessionId: "__warmup__", events: [] })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`fake-engine server never came up on :${port}: ${lastErr}`)
}

let tmpRoot: string
let repo: string
let homeDir: string
let kobe: KobeHandle | null = null

beforeAll(() => {
  // Sanity check: fixture script exists so the test fails loudly if the
  // harness layout drifts.
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
})

test("G2 — create task, send prompt, see assistant delta in chat", async () => {
  // ---- fixtures -------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-g2-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  const port = await pickFreePort()

  // ---- spawn kobe under PTY in fake-engine mode -----------------
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  // Boot screen visible.
  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

  // The fake-engine HTTP server is mounted asynchronously inside
  // kobe. Wait for it before scripting.
  await waitForFakeServer(port)

  // ---- script the fake engine BEFORE submitting ------------------
  // The first runTask spawn allocates `fake-1`. Pre-script events
  // BEFORE we send the prompt so they're queued when the pump
  // attaches. Wave 3 G changed the new-task flow to auto-submit
  // the dialog's first prompt — so the engine starts the moment
  // the dialog commits, and we need scripted events ready by then.
  const helloEvents: EngineEvent[] = [{ type: "assistant.delta", text: "hello from kobe" }, { type: "done" }]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events: helloEvents })

  // ---- open new-task dialog and fill it in ----------------------
  // Wave 3 G dropped the explicit `title` field. The dialog now
  // collects (prompt, repo). The first field is `first prompt`.
  await kobe.sendKeys("\x0e") // ctrl+n
  await kobe.waitFor((s) => s.includes("New task"), 5_000)

  // First field (prompt) is focused on dialog open. Type the prompt
  // — the orchestrator will derive a sidebar title from it.
  await kobe.typeText("demo task ping")

  // Tab to switch to repo field. We override the default repo
  // (process.cwd() = the kobe checkout) with our fixture repo path.
  await kobe.sendKeys("\t")

  // The repo field is pre-filled with process.cwd(); we need to
  // clear it. Send backspaces, then type our fixture path. The
  // input renderable's max value depth makes more-than-enough
  // backspaces safe.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f") // DEL — InputRenderable maps to deleteCharBackward
  }
  await kobe.typeText(repo)

  // Submit (Enter on the repo field commits the dialog AND auto-
  // sends the prompt to the freshly-created task — Wave 3 G
  // pendingPrompt flow).
  await kobe.sendKeys("\r")

  // ---- sidebar updates with the new task ------------------------
  // The derived title is the prompt verbatim (≤40 chars).
  const afterCreate = await kobe.waitFor((s) => s.includes("demo task ping"), 10_000)
  expect(afterCreate).toContain("demo task ping")

  // ---- assistant delta visible ----------------------------------
  // The prompt was auto-submitted, so the engine fires immediately.
  const finalScreen = await kobe.waitFor((s) => s.includes("hello from kobe"), 15_000)
  expect(finalScreen).toContain("hello from kobe")

  // Also: the user's own prompt and the assistant prefix glyph are
  // visible. Wave 4.B renamed the assistant header from the literal
  // word "assistant" to Claude Code's BLACK_CIRCLE figure (`⏺` on
  // darwin, `●` elsewhere; both are visually a filled circle in TUIs)
  // to match the leaked Anthropic source's `AssistantTextMessage`.
  expect(finalScreen).toContain("demo task ping")
  expect(finalScreen).toMatch(/[⏺●]/)

  // ---- clean exit ------------------------------------------------
  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 60_000)
