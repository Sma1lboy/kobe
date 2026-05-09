/**
 * Wave 4 Stream W4.PR — Create PR button behavior test.
 *
 * The load-bearing self-test for the "agent does git/PR work via prompt
 * injection" pattern. Spawns kobe under the fake engine, creates a task,
 * triggers the Create-PR action, and asserts that:
 *
 *   1. A new chat user-row appears containing the rendered PR prompt
 *      (we look for the load-bearing literal "Follow these steps to
 *      create a PR" — straight from the default template, so any drift
 *      in the substitution pipeline trips this test).
 *   2. The substitution worked (the rendered prompt names the actual
 *      branch and target).
 *
 * Mouse-clicking a `<box onMouseUp>` from a PTY harness is awkward
 * (opentui's mouse-event delivery requires SGR mouse-mode negotiation
 * that the screen-capture buffer doesn't honor). Instead we use a hidden
 * test affordance from `src/tui/app.tsx`: setting `KOBE_TEST_PR_HOTKEY=1`
 * registers a `ctrl+shift+p` binding that calls the same handler the
 * button's onMouseUp does. This affordance exists ONLY for this test;
 * it is not registered when the env var is unset.
 *
 * Side-channel reuse: same HTTP fake-engine protocol as G2/G3 (POST
 * /script, POST /finish on KOBE_TEST_FAKE_PORT).
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

/**
 * Trigger the PR flow on the kobe child via the test side-channel.
 * Returns the rendered prompt that was passed to the engine — the test
 * uses this to assert on substitution + content. Polls past the brief
 * 503 window where the Shell hasn't yet mounted the trigger.
 */
async function triggerPR(port: number, timeoutMs = 15_000): Promise<{ taskId: string; prompt: string }> {
  const deadline = Date.now() + timeoutMs
  let lastErr = "(no attempts yet)"
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: "{}",
    })
    if (res.ok) {
      return (await res.json()) as { taskId: string; prompt: string }
    }
    lastErr = `${res.status} ${await res.text()}`
    if (res.status !== 503) {
      throw new Error(`fake-engine /pr failed: ${lastErr}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`fake-engine /pr timed out (last: ${lastErr})`)
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

async function buildFixture(): Promise<{ tmpRoot: string; homeDir: string; repo: string }> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-w4pr-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  const repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  return { tmpRoot, homeDir, repo }
}

/**
 * Drive the new-task dialog from a fresh boot: open it, type the prompt,
 * tab to the repo field, clear the prefilled cwd, type the fixture path,
 * submit.
 */
async function fillNewTaskDialog(kobe: KobeHandle, prompt: string, repo: string): Promise<void> {
  await kobe.sendKeys("\x0e") // ctrl+n
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  await kobe.typeText(prompt)
  await kobe.sendKeys("\t")
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  await kobe.sendKeys("\r")
}

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
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = null
})

test("W4.PR — Create-PR injects rendered prompt into the active task's chat", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
      // Activates the hidden ctrl+y binding that fires the same handler
      // as the CreatePRButton's onMouseUp. See src/tui/app.tsx for the
      // wiring + comment on why ctrl+y vs ctrl+p.
      KOBE_TEST_PR_HOTKEY: "1",
    },
    // Wider viewport so the user-row prompt has room to render its
    // long sentences contiguously in the cumulative PTY capture.
    cols: 200,
    rows: 60,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // ---- task 1: get a worktree-backed task selected ---------------
  // Pre-script the first session (`fake-1`) so the auto-submitted
  // initial prompt drains and we get back to an idle state.
  const initEvents: EngineEvent[] = [{ type: "assistant.delta", text: "ready" }, { type: "done" }]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events: initEvents })

  await fillNewTaskDialog(kobe, "pr smoke", fixture.repo)
  await kobe.waitFor((s) => s.includes("pr smoke"), 10_000)
  await kobe.waitFor((s) => s.includes("ready"), 15_000)

  // ---- fire the Create-PR action -------------------------------------
  // We trigger via the fake-engine HTTP server's POST /pr endpoint
  // rather than a keystroke. Rationale: opentui's <input> Renderable
  // (the chat composer) takes focus right after task creation and the
  // input + global keymap dispatch order in opentui v0.2.4 makes
  // single-key control chord delivery from a PTY harness fragile to
  // assert against. The /pr endpoint reaches the same `requestPR` path
  // the CreatePRButton's onMouseUp handler reaches (via the global
  // `__kobeTestRequestPR` shim mounted by Shell). The hidden ctrl+y
  // hotkey (KOBE_TEST_PR_HOTKEY=1) remains as a secondary affordance
  // for tests that drive kobe without the side-channel.
  const { prompt } = await triggerPR(port)

  // ---- assert the rendered prompt is what the engine received -------
  // The /pr endpoint returns the same prompt that requestPR submitted
  // to runTask. We assert on its contents AND on the chat-screen
  // rendering: requestPR dispatches a synthetic `user.inject` event on
  // the orchestrator bus before calling runTask, so the chat shows the
  // injected prompt as a normal user row in the same tick.
  expect(prompt).toContain("Follow these steps to create a PR")
  // Wait for the user row to render — the user.inject event arrives
  // after dispatch + Solid re-render, which is async w.r.t. the
  // triggerPR HTTP response.
  await kobe.waitFor((s) => s.includes("Follow these steps to create a PR"), 10_000)
  // Substitution sanity: the target branch is 'main' (origin/HEAD
  // unset on the bare-init fixture, so build.ts falls back). The
  // rendered prompt names it explicitly.
  expect(prompt).toContain("The target branch is main.")
  // No `{{...}}` markers leak through — the renderer substituted them
  // all without reaching for unknown placeholders.
  expect(prompt).not.toContain("{{branch}}")
  expect(prompt).not.toContain("{{targetBranch}}")
  expect(prompt).not.toContain("{{dirtyCountSentence}}")
  expect(prompt).not.toContain("{{upstreamSentence}}")

  // ---- end-to-end seam: the orchestrator actually invoked the engine
  // The /pr endpoint awaits `props.orchestrator.requestPR(task.id)`
  // which awaits `runTask` which awaits the engine's spawn/resume.
  // Reaching this line means the full button → orchestrator.requestPR
  // → runTask → engine.resume pipeline returned without throwing. If
  // any seam was broken (no worktree, no repo, canceled, runTask
  // rejection) triggerPR above would have surfaced an HTTP 500.
  expect(prompt.length).toBeGreaterThan(100)
  // Sanity: the prompt names the task's actual current branch (kobe
  // task branches start with "kobe/"). Confirms gatherPRState read
  // the worktree path it was given.
  expect(prompt).toContain("The current branch is kobe/")

  await kobe.exit()
}, 90_000)
