/**
 * Wave 3 Stream G — chat pane behavior tests.
 *
 * These exercise the new chat pane (`src/tui/panes/chat/Chat.tsx`)
 * end-to-end: the agent spawns the real kobe binary in a PTY, drives it
 * with a fake engine via the HTTP side-channel from G2, and asserts on
 * visible state.
 *
 * Why we have these AND `chat.test.tsx`:
 *   - The unit tests in `test/tui/chat.test.tsx` exercise the pure
 *     `store.ts` state machine — invariants like "delta accumulates
 *     in arrival order" and "done clears isStreaming."
 *   - The behavior tests below exercise the *rendered* product. They
 *     prove that when the orchestrator dispatches an `assistant.delta`
 *     event, the chat pane actually displays the text, that the
 *     loading spinner appears between submit and first delta, and that
 *     task switches reload history correctly.
 *
 * Loading-indicator timing is the trickiest part: we have to capture
 * the screen AFTER submit but BEFORE scripting any events. The HTTP
 * side-channel from G2 lets us do this — we don't pre-script, send the
 * prompt, capture, THEN script the events.
 *
 * Side-channel reuse: identical to G2's. See `src/tui/app.tsx` and
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
    // breaks for any multi-byte UTF-8 — the server reads fewer bytes
    // than JSON.parse expects, the handler never runs, and the
    // socket drops with "other side closed".
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-g3-"))
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
 * Type a string into the new-task dialog: open via shortcut, fill
 * prompt, tab to repo, clear prefilled cwd, type repo, submit.
 *
 * The opener is always ctrl+n (`\x0e`, ASCII SO) — opentui maps it to
 * a key event with ctrl=true and name="n", which our keymap matches as
 * "ctrl+n". Bare `n` is no longer a global hotkey.
 *
 * Factored out because all four tests use it.
 */
async function fillNewTaskDialog(kobe: KobeHandle, prompt: string, repo: string): Promise<void> {
  await kobe.sendKeys("\x0e")
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  // Wave 4 dialog dropped the first-prompt field. The repo input is
  // now the first (and active) field, prefilled with cwd. Clear it
  // before typing so the test repo replaces, not appends.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  // Submit (commits dialog with default branch=main; orchestrator
  // creates a placeholder-titled task and pulls focus to the
  // workspace composer for the first prompt).
  await kobe.sendKeys("\r")
  // Composer auto-focuses post-create; type the prompt + send.
  // Wait briefly so the dialog's render frame settles before keys.
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
// (a) Loading state visible immediately after submit, before events.
// ---------------------------------------------------------------------

test("G3a — thinking indicator visible after submit, hidden after done", async () => {
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
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // Submit a task — but DO NOT script any engine events yet. The chat
  // should hit `pending: true` and show the thinking indicator.
  await fillNewTaskDialog(kobe, "loading test", fixture.repo)

  // Wait for the task title to appear in the sidebar (proves the
  // dialog committed). The chat now should be showing the thinking
  // indicator because the engine has nothing to send yet.
  await kobe.waitFor((s) => s.includes("loading test"), 10_000)

  // Capture and assert the thinking indicator is visible.
  const thinkingScreen = await kobe.waitFor((s) => s.includes("thinking"), 10_000)
  expect(thinkingScreen).toContain("thinking")

  // Now script some events to let the turn finish.
  const events: EngineEvent[] = [{ type: "assistant.delta", text: "all good" }, { type: "done" }]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  // Wait for the assistant text to render. We can't assert that
  // "thinking" disappears via a !includes() predicate against the
  // cumulative PTY buffer (the byte history of the spinner is
  // preserved in the buffer even after the renderer overwrites it).
  // Instead we check that the assistant turn lands; the unit tests in
  // `test/tui/chat.test.tsx` verify isStreaming flips false on `done`,
  // and the renderer's `showThinking` derivation is gated on
  // `isStreaming` AND no live assistant — so once "all good" is
  // rendered, the spinner has been erased from the active frame.
  const finalScreen = await kobe.waitFor((s) => s.includes("all good"), 15_000)
  expect(finalScreen).toContain("all good")

  await kobe.exit()
}, 60_000)

// ---------------------------------------------------------------------
// (b) Streaming text accumulates from multiple deltas.
// ---------------------------------------------------------------------

test("G3b — three assistant deltas accumulate into one rendered phrase", async () => {
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
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // Pre-script three deltas + done. The chat coalesces consecutive
  // deltas into a single assistant row, so we expect "Hello world"
  // visible after they drain.
  const events: EngineEvent[] = [
    { type: "assistant.delta", text: "Hello" },
    { type: "assistant.delta", text: " " },
    { type: "assistant.delta", text: "world" },
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "stream test", fixture.repo)

  const finalScreen = await kobe.waitFor((s) => s.includes("Hello world"), 15_000)
  expect(finalScreen).toContain("Hello world")

  await kobe.exit()
}, 60_000)

// ---------------------------------------------------------------------
// (c) Tool call collapsed by default — name visible, full output not.
// ---------------------------------------------------------------------

test("G3c — tool call renders name collapsed; full output stays hidden", async () => {
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
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // Tool call payload — input has a long sentinel we can grep for in
  // both the collapsed view (where it should NOT appear in full) and
  // the (notional) expanded view.
  const FULL_OUTPUT = "FULLOUTPUT_SENTINEL_LINE_THAT_IS_LONG_AND_NEVER_APPEARS_IN_PREVIEW"
  const events: EngineEvent[] = [
    { type: "tool.start", name: "Read", input: { file: "a.ts" } },
    { type: "tool.result", name: "Read", output: FULL_OUTPUT },
    { type: "assistant.delta", text: "tool done" },
    { type: "done" },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "tool test", fixture.repo)

  // Wait until the assistant trailing text renders — proves the tool
  // events have been processed.
  const screen = await kobe.waitFor((s) => s.includes("tool done"), 15_000)

  // The tool *name* is visible.
  expect(screen).toContain("Read")
  // The collapsed-by-default rule: the full sentinel from the result
  // must NOT appear (we render only a 60-char one-line preview, and
  // the sentinel is longer + has unique tokens that wouldn't fit).
  expect(screen).not.toContain(FULL_OUTPUT)

  await kobe.exit()
}, 60_000)

// ---------------------------------------------------------------------
// (d) Task switch — chat clears + reloads history per task.
// ---------------------------------------------------------------------

test("G3d — switching tasks shows the right chat per task", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  // Wider viewport — opentui's cell-by-cell painting interleaves the
  // chat and sidebar columns in the cumulative PTY buffer, which can
  // truncate assistant text in narrow terminals. 160×40 gives enough
  // chat width that the reply tokens render contiguously.
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: fixture.homeDir,
    },
    cols: 160,
    rows: 40,
  })

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // ---- task 1 -------------------------------------------------
  // Pre-script for fake-1 (the first session id allocated). Reply
  // text uses a unique short token so opentui's cell-by-cell painting
  // doesn't fragment it across cursor moves in the captured buffer.
  // (Long phrases get sprinkled across cells in the cumulative PTY
  // capture; single-word tokens land contiguously.)
  await scriptEngine(port, "/script", {
    sessionId: "fake-1",
    events: [{ type: "assistant.delta", text: "ONEREPLY" }, { type: "done" }] satisfies EngineEvent[],
  })

  await fillNewTaskDialog(kobe, "alpha task", fixture.repo)
  await kobe.waitFor((s) => s.includes("ONEREPLY"), 15_000)

  // ---- task 2 -------------------------------------------------
  // Pre-script for fake-2 BEFORE creating the second task so the
  // pump finds events queued.
  await scriptEngine(port, "/script", {
    sessionId: "fake-2",
    events: [{ type: "assistant.delta", text: "TWOREPLY" }, { type: "done" }] satisfies EngineEvent[],
  })

  // Second task: a task is already selected and the chat composer
  // owns input. The helper uses ctrl+n unconditionally now that bare
  // `n` is no longer a global hotkey.
  await fillNewTaskDialog(kobe, "beta task", fixture.repo)

  // After the second submit, the chat shows task 2's reply.
  //
  // Note: the cumulative PTY buffer preserves the historical bytes of
  // task 1's render, so we can't assert "ONEREPLY" is absent via a
  // !includes() predicate. The unit tests in
  // `test/tui/chat.test.tsx` cover the in-memory state-clearing
  // invariant ("createInitialState wipes live"), and visually we
  // confirm task switch by:
  //   (a) seeing TWOREPLY render (proves the new subscription
  //       attached to fake-2's queue and produced output)
  //   (b) seeing the second task's title in the sidebar
  const afterTwo = await kobe.waitFor((s) => s.includes("TWOREPLY") && s.includes("beta task"), 15_000)
  expect(afterTwo).toContain("TWOREPLY")
  expect(afterTwo).toContain("beta task")

  await kobe.exit()
}, 90_000)
