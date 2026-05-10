/**
 * Behavior tests for the user-input pause flows — ExitPlanMode plan
 * approval and AskUserQuestion multi-choice picker.
 *
 * These complement the unit coverage in `test/orchestrator/core.test.ts`
 * (parser + prompt-renderer + applyEvent reducer) by proving the
 * *rendered* product end-to-end:
 *
 *   1. When the engine emits the tool, the picker row appears in chat
 *      with the right banner + content (plan body for ExitPlanMode,
 *      header chip + question + options for AskUserQuestion).
 *   2. The composer locks: the placeholder switches to the
 *      "answer the prompt above to continue" hint so the user can't
 *      type a freeform reply that would race the picker's resolution.
 *
 * We deliberately don't drive the click-through to Approve/Submit
 * here — the orchestrator unit tests already cover respondToInput
 * end-to-end with the FakeAIEngine, and the inline mouse-click path
 * needs SGR-mouse + position-aware delivery that the PTY harness
 * doesn't reliably honour. The big-risk regression (subprocess yapping
 * past the request, composer staying typeable) is what these
 * behavior tests pin down.
 *
 * Side-channel reuse: identical to G3's. See `g3-chat.test.ts` and
 * `g2-end-to-end.test.ts` for the protocol (POST /script, POST /finish).
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
    // No explicit content-length: fetch computes the byte length
    // automatically. Setting it from `body.length` (character count)
    // breaks for any multi-byte UTF-8 (e.g. em-dash) — the server
    // reads fewer bytes than JSON.parse expects, the request handler
    // never runs, and the socket drops with "other side closed".
    headers: { "content-type": "application/json" },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${text}`)
  }
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-approval-"))
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
 * Open the new-task dialog and submit. Lifted from g3-chat.test.ts —
 * any change to the dialog shape needs to land in both helpers.
 */
async function fillNewTaskDialog(
  kobe: KobeHandle,
  prompt: string,
  repo: string,
  openWith: "n" | "ctrl+n" = "n",
): Promise<void> {
  if (openWith === "n") {
    await kobe.sendKeys("n")
  } else {
    await kobe.sendKeys("\x0e")
  }
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  // Repo path is the first (active) field, prefilled with cwd. Clear
  // before typing so the test repo replaces.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  await kobe.sendKeys("\r")
  // Composer auto-focuses post-create; type the prompt + send.
  await new Promise((r) => setTimeout(r, 250))
  await kobe.typeText(prompt)
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

// ---------------------------------------------------------------------
// ExitPlanMode — plan approval picker visible + composer locked
// ---------------------------------------------------------------------

test("approval — ExitPlanMode renders the plan + Approve/Reject buttons + locks composer", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
    },
    cols: 120,
    rows: 40,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // Pre-script: model immediately calls ExitPlanMode with a recognisable
  // plan body. The orchestrator's pumpEvents will detect this on
  // tool.start, kill the subprocess, and broadcast user_input.request —
  // which the chat renders as an ApprovalRow.
  const events: EngineEvent[] = [
    {
      type: "tool.start",
      name: "ExitPlanMode",
      input: {
        plan: "## Step 1: do the thing\n\nThe SENTINEL_PLAN_BODY string proves the plan body rendered.",
        filePath: "/tmp/SENTINEL_PLAN_PATH.md",
      },
    },
    // A trailing `done` is scripted but should never be consumed — the
    // pump kills the subprocess on tool.start and breaks the for-await
    // before reaching it.
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "approval test", fixture.repo)

  // Banner is visible.
  await kobe.waitFor((s) => s.includes("Awaiting your approval"), 15_000)

  // Plan body is rendered through Markdown — the sentinel string from
  // the plan input must appear verbatim in the rendered chat.
  const withPlan = await kobe.waitFor((s) => s.includes("SENTINEL_PLAN_BODY"), 5_000)
  expect(withPlan).toContain("SENTINEL_PLAN_BODY")
  expect(withPlan).toContain("SENTINEL_PLAN_PATH.md")

  // Approve / Reject buttons are visible (the bracketed-chip vocabulary
  // means we look for the literal `[ Approve ]` text).
  expect(withPlan).toContain("Approve")
  expect(withPlan).toContain("Reject")

  // Composer locked — the placeholder switched to the lock hint.
  // Allow a tick for the createMemo to recompute and Composer to
  // re-render after the user_input.request event lands. Compare with
  // whitespace collapsed: opentui's text wrapper drops the space at
  // a wrap point, so the rendered string is "answerthe promptabove
  // to continue" not "answer the prompt above to continue". We don't
  // care about the wrap geometry; we only care that the lock copy is
  // visible somewhere in the composer area.
  await new Promise((r) => setTimeout(r, 500))
  const lockedScreen = await kobe.capture()
  expect(lockedScreen.replace(/\s+/g, "")).toContain("answertheprompt")
  expect(lockedScreen.replace(/\s+/g, "")).toContain("tocontinue")

  await kobe.exit()
}, 60_000)

// ---------------------------------------------------------------------
// AskUserQuestion — multi-choice picker visible + composer locked
// ---------------------------------------------------------------------

test("approval — AskUserQuestion renders the question + options + locks composer", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
    },
    cols: 120,
    rows: 40,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  const events: EngineEvent[] = [
    {
      type: "tool.start",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "SENTINEL_QUESTION_TEXT — pick one?",
            header: "PickHdr",
            multiSelect: false,
            options: [
              { label: "OPTION_ALPHA", description: "first description" },
              { label: "OPTION_BETA", description: "second description" },
            ],
          },
        ],
      },
    },
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "question test", fixture.repo)

  // Banner.
  await kobe.waitFor((s) => s.includes("Awaiting your answer"), 15_000)

  // Header chip + question text + both options + at least one description
  // all rendered.
  const withQuestion = await kobe.waitFor((s) => s.includes("SENTINEL_QUESTION_TEXT"), 5_000)
  expect(withQuestion).toContain("PickHdr")
  expect(withQuestion).toContain("OPTION_ALPHA")
  expect(withQuestion).toContain("OPTION_BETA")
  expect(withQuestion).toContain("first description")

  // Submit button is rendered (greyed until the user picks, but the
  // text is always there).
  expect(withQuestion).toContain("Submit")

  // Composer locked. Whitespace-collapsed compare — see the
  // ExitPlanMode test for why.
  await new Promise((r) => setTimeout(r, 500))
  const lockedScreen = await kobe.capture()
  expect(lockedScreen.replace(/\s+/g, "")).toContain("answertheprompt")
  expect(lockedScreen.replace(/\s+/g, "")).toContain("tocontinue")

  await kobe.exit()
}, 60_000)
