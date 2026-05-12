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
import type { EngineEvent, UserInputResponse } from "../../src/types/engine.ts"
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

/**
 * Drive the user-input pause flow's resolve step from outside the TUI.
 * POSTs the response to the `/respond` side-channel that the Shell
 * mounts (see `__kobeTestRespondToInput` in app.tsx). The endpoint
 * picks the latest pending request for the active task and runs it
 * through `Orchestrator.respondToInput` — same code path the chat row's
 * Approve / Submit click would exercise, only without faking SGR mouse
 * events the screen-capture path can't deliver.
 *
 * Returns the `requestId` and the rendered synthetic prompt so the test
 * can assert on either (the prompt is the user-facing text the model
 * sees on `--resume`, and the new user row in chat).
 */
async function respondToInputViaSideChannel(
  port: number,
  response: UserInputResponse,
): Promise<{ taskId: string; requestId: string; prompt: string }> {
  const body = JSON.stringify(response)
  const res = await fetch(`http://127.0.0.1:${port}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`/respond failed: ${res.status} ${text}`)
  }
  return (await res.json()) as { taskId: string; requestId: string; prompt: string }
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
    await kobe.sendKeys("\x0e")
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

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
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

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
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

  // Auto-added "Other" affordance — kobe synthesizes this client-side
  // per the AskUserQuestion spec's "always offer custom text" contract.
  // The label is rendered as a normal option row alongside the
  // model-supplied options.
  expect(withQuestion).toContain("Other")

  // Composer is NOT locked for questions (only ExitPlanMode locks —
  // approval is binary, but questions accept free-text via composer
  // as a parallel path to picking "Other"). The lock copy must NOT
  // appear; instead we render a soft hint telling the user they can
  // either pick or type. Whitespace-collapsed compare to be robust
  // against opentui's text-wrap quirk.
  await new Promise((r) => setTimeout(r, 500))
  const screen = await kobe.capture()
  const collapsed = screen.replace(/\s+/g, "")
  expect(collapsed).not.toContain("answertheprompt")
  // Soft hint copy from Chat.tsx — see the pendingQuestion <Show> block.
  expect(collapsed).toContain("typeyourownanswer")

  await kobe.exit()
}, 60_000)

// ---------------------------------------------------------------------
// Click-through coverage — the resolve half of the picker flows.
//
// The two tests above pin down the picker render + composer lock. The
// pair below proves the other half of the contract:
//
//   1. Pressing Approve / Submit (via the side-channel that simulates
//      the click — see `respondToInputViaSideChannel`) actually flips
//      the picker row to its resolved state (`approved` chip for
//      ExitPlanMode, the chosen option label rendered as the answer
//      for AskUserQuestion).
//   2. The orchestrator emits a synthetic `user.inject` row carrying
//      the model-facing prompt that `renderUserInputResponsePrompt`
//      builds — i.e. the text that gets sent on `--resume`.
//
// These complement the existing `respondToInput` unit tests in
// `test/orchestrator/core.test.ts` by proving the chat actually
// re-renders end-to-end. If a future refactor breaks the
// `user_input.resolved` → store reducer wiring (or composer's
// `hasPendingInput` accessor), the unit tests would still pass but
// the user would see a stuck "Awaiting your approval" banner; these
// behavior tests catch that.
// ---------------------------------------------------------------------

test("approval — ExitPlanMode click-through approves + emits the synthetic resume prompt", async () => {
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

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
  await waitForFakeServer(port)

  const events: EngineEvent[] = [
    {
      type: "tool.start",
      name: "ExitPlanMode",
      input: {
        plan: "## Step 1\n\nThe APPROVE_SENTINEL_PLAN string proves the plan body rendered.",
        filePath: "/tmp/SENTINEL_PLAN_PATH.md",
      },
    },
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "approve click-through", fixture.repo)

  // Wait for the picker to render and pendingInput to be populated.
  await kobe.waitFor((s) => s.includes("Awaiting your approval"), 15_000)
  await kobe.waitFor((s) => s.includes("APPROVE_SENTINEL_PLAN"), 5_000)

  // Pre-script the resumed session so the FakeAIEngine has a `done`
  // ready when respondToInput → runTask → engine.resume kicks off.
  // Without this the resume queue would block forever and the test
  // would time out waiting for things downstream of the inject. The
  // resumed session reuses sessionId `fake-1` — see FakeAIEngine.resume
  // which reopens the same queue.
  await scriptEngine(port, "/script", { sessionId: "fake-1", events: [{ type: "done" }] })

  // Click-through (via side-channel — see helper docstring for why).
  const result = await respondToInputViaSideChannel(port, { kind: "approve_plan", approve: true })
  expect(result.requestId).toMatch(/^req-/)
  // The synthetic prompt the model will see on resume.
  expect(result.prompt).toContain("Plan approved")

  // Picker row flipped to the resolved state. The `[approved]` chip
  // and the "User approved Claude's plan" banner are positive
  // assertions only — `kobe.capture()` returns the cumulative scrollback
  // buffer (see driver.ts), not the current visible frame, so the
  // pre-resolve "[ Approve ]" / "[ Reject ]" render is still in the
  // buffer at this point. We pin the resolve transition by checking
  // both new-state strings appear (and via `waitFor` order, that they
  // appear AFTER the resolve was issued).
  const resolved = await kobe.waitFor((s) => s.replace(/\s+/g, "").includes("[approved]"), 10_000)
  const collapsed = resolved.replace(/\s+/g, "")
  expect(collapsed).toContain("UserapprovedClaude")

  // The synthetic user.inject row landed in chat — i.e. the resume
  // prompt is actually visible to the user as a normal user-row. This
  // is the load-bearing assertion: it proves user.inject fired with
  // the right text, which is what the model would see on `--resume`.
  await kobe.waitFor((s) => s.includes("Plan approved. Please proceed"), 5_000)

  await kobe.exit()
}, 60_000)

test("approval — AskUserQuestion click-through submits answer + emits the synthetic resume prompt", async () => {
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

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
  await waitForFakeServer(port)

  const questionText = "ANSWER_SENTINEL_QUESTION — pick one?"
  const events: EngineEvent[] = [
    {
      type: "tool.start",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: questionText,
            header: "PickHdr",
            multiSelect: false,
            options: [
              { label: "ANSWER_OPTION_ALPHA", description: "first description" },
              { label: "ANSWER_OPTION_BETA", description: "second description" },
            ],
          },
        ],
      },
    },
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "answer click-through", fixture.repo)

  await kobe.waitFor((s) => s.includes("Awaiting your answer"), 15_000)
  await kobe.waitFor((s) => s.includes("ANSWER_OPTION_ALPHA"), 5_000)

  // Pre-script the resumed session — same rationale as the
  // ExitPlanMode click-through test.
  await scriptEngine(port, "/script", { sessionId: "fake-1", events: [{ type: "done" }] })

  // Submit the first option. The answers map is keyed by the question
  // text and valued by the chosen option label — same shape Chat.tsx
  // builds in QuestionRow.submit().
  const answers: Record<string, string> = { [questionText]: "ANSWER_OPTION_ALPHA" }
  const result = await respondToInputViaSideChannel(port, { kind: "ask_question", answers })
  expect(result.requestId).toMatch(/^req-/)
  // Synthetic prompt format: a "You asked:" preamble, one bullet per
  // question, and a trailing "Please continue."
  expect(result.prompt).toContain("You asked:")
  expect(result.prompt).toContain("ANSWER_OPTION_ALPHA")
  expect(result.prompt).toContain("Please continue")

  // Picker row flipped to the answered state. Positive assertions
  // only — `kobe.capture()` returns the cumulative scrollback buffer
  // (see driver.ts + the matching note in the ExitPlanMode click-through
  // test above), so the pending "[ Submit ]" render is still in the
  // buffer at this point. We pin the resolve transition via the
  // [submitted] chip + the "Answered" banner copy + the chosen label
  // appearing as the rendered answer line.
  const resolved = await kobe.waitFor((s) => s.replace(/\s+/g, "").includes("[submitted]"), 10_000)
  const collapsed = resolved.replace(/\s+/g, "")
  expect(collapsed).toContain("Answered")
  expect(resolved).toContain("ANSWER_OPTION_ALPHA")

  // Synthetic user-row from user.inject is in chat with the rendered
  // answer text — proves the right prompt got sent on resume.
  await kobe.waitFor((s) => s.includes("ANSWER_OPTION_ALPHA") && s.includes("You asked"), 5_000)

  await kobe.exit()
}, 60_000)
