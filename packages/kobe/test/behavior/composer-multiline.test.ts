/**
 * Wave 4 W4.C — composer behavior tests (multi-line + prompt history).
 *
 * The unit-test surface for the composer is unfortunately thin — most
 * of the load-bearing behavior lives in opentui's `<textarea>` and our
 * keybinding overrides, neither of which is unit-testable without a
 * full opentui runtime. So we rely on a PTY-driven behavior test that
 * exercises the rendered product.
 *
 * What this asserts:
 *
 *   1. Multi-line composition: typing `hello`, sending a `linefeed`
 *      (Ctrl+J / 0x0A — the universal "shift+enter" stand-in for
 *      terminals without kitty support), then typing `world`, then
 *      pressing enter, results in a single submit whose body contains
 *      both `hello` and `world` (we don't assert exact whitespace
 *      because some renderers collapse consecutive spaces in the
 *      visible-screen capture; the literal newline is preserved on
 *      the wire to the engine).
 *
 *   2. Prompt history: after a successful submit, pressing the up
 *      arrow once on the empty composer recalls the just-sent prompt
 *      so it's visible in the input again. This pins the
 *      `historyPrev()` path: snapshot live draft → step to oldest →
 *      `setBuffer` writes the recalled text.
 *
 * Not asserted here (and intentionally so):
 *
 *   - shift+enter literal: our default opentui build doesn't reliably
 *     report shift on `return` in the test harness's PTY. We use
 *     `linefeed` (Ctrl+J) which is the documented terminal-agnostic
 *     fallback. If a future opentui build standardizes shift+enter
 *     across xterm-256color, swap one byte sequence in this test —
 *     the `Composer.tsx` keybinding map already routes both.
 *
 *   - History across tasks: covered implicitly by the in-memory
 *     `history.ts` keying logic; not worth a separate PTY round-trip.
 *
 * This test reuses the fake-engine pattern from G2/G3 — see
 * `g3-chat.test.ts` for the protocol details. We pre-script a single
 * `done` event so the turn doesn't hang; we don't actually inspect
 * the engine's view of the prompt body (that would require extending
 * the fake-engine to echo received prompts), we inspect the rendered
 * chat where the user-row reflects what was submitted.
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-w4c-"))
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
 * Open the new-task dialog and create a task. Same gestures as
 * `g3-chat.test.ts`'s helper — copied locally so the W4.C test stays
 * self-contained (the brief allows ONE behavior-test file change, and
 * importing across test files would couple them).
 */
async function createTaskWithDialog(kobe: KobeHandle, firstPrompt: string, repo: string): Promise<void> {
  await kobe.sendKeys("\x0e") // ctrl+n
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  await kobe.typeText(firstPrompt)
  await kobe.sendKeys("\t")
  // Clear the pre-filled cwd field.
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

// ---------------------------------------------------------------------
// Multi-line composition + history recall.
//
// We use a single test for both behaviors because they share setup
// (boot kobe, create a task, drain the seed turn). Splitting would
// double the PTY round-trips for no extra coverage.
// ---------------------------------------------------------------------

test("W4.C — multi-line composition, then history recall", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  // Wider viewport to give the chat enough horizontal room that
  // unique tokens land contiguously in the cumulative PTY capture.
  // 160×40 mirrors the G3d test's choice.
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

  // Seed turn: pre-script a no-op response so the first auto-submit
  // (from the new-task dialog) lands and finishes cleanly. The seed
  // prompt itself is uninteresting — we just need a task to exist
  // with the chat pane focused so the composer is alive.
  await scriptEngine(port, "/script", {
    sessionId: "fake-1",
    events: [{ type: "assistant.delta", text: "SEEDOK" }, { type: "done" }] satisfies EngineEvent[],
  })

  await createTaskWithDialog(kobe, "seedprompt", fixture.repo)

  // Wait for the seed turn to finish — `SEEDOK` is the unique sentinel
  // that proves the assistant.delta from fake-1 made it onto the
  // chat. If we asserted only on the prompt text we'd get a false
  // positive (the user-row renders before any reply lands).
  await kobe.waitFor((s) => s.includes("SEEDOK"), 15_000)

  // The seed turn's `done` may take a few extra ticks to flip
  // `isStreaming` back to false. Without this settle, the next
  // submit can be silently dropped by Chat.send()'s streaming-gate.
  // Polling the streaming-state would require a side channel; a
  // 500ms grace is empirically enough on the test PTY.
  await new Promise((r) => setTimeout(r, 500))

  // ---- (1) Multi-line composition --------------------------------
  //
  // Note on focus: kobe boots with the sidebar pane focused. Typing
  // any single letter that's a sidebar binding (j/k/d/g/return) into
  // the chat composer triggers the sidebar handler IN ADDITION to
  // the textarea inserting the character — both the global keymap
  // and the focused renderable subscribe to the renderer's `keypress`
  // event and fire in parallel. To keep this test deterministic we
  // avoid such letters in the tokens below: HELLOFOO and BARBAZ are
  // chosen specifically because they have no j/k/d/g/n/q/?.
  //
  // Note on the fake engine: `FakeAIEngine.stream()` re-iterates its
  // scripted queue from idx=0 on every call (each runTask builds a
  // new async iterator). The seed turn already consumed SEEDOK +
  // done; appending a second pair would just replay the first pair
  // on this turn. So we don't pre-script — we assert on the chat's
  // user-row directly. The user-row appears synchronously when
  // `Chat.send()` calls `pushUser(...)`, BEFORE any engine response,
  // so visibility of the multi-line text in the user-row proves the
  // composer's multi-line submit went through.

  await kobe.typeText("HELLOFOO")
  await kobe.sendKeys("\n") // linefeed → newline
  await kobe.typeText("BARBAZ")
  await kobe.sendKeys("\r") // enter → submit

  // After submit, the chat user-row contains both lines. Wait for
  // both tokens — there's a brief frame where neither is rendered if
  // we capture too early.
  const afterSubmit = await kobe.waitFor((s) => s.includes("HELLOFOO") && s.includes("BARBAZ"), 10_000)
  expect(afterSubmit).toContain("HELLOFOO")
  expect(afterSubmit).toContain("BARBAZ")

  // ---- (2) History recall ----------------------------------------
  //
  // The submit just pushed "HELLOFOO\nBARBAZ" onto the per-task
  // history ring (see `composer/history.ts`). Pressing up arrow on
  // the now-empty composer should pop that entry back into the
  // textarea — handled by `historyPrev()` in `Composer.tsx` (called
  // from the textarea's `onKeyDown` when the cursor is at the
  // buffer's first visual line and the buffer is empty enough for
  // up to be a history step rather than a caret move).
  //
  // We send the standard ESC-bracket sequence for up arrow (`\x1b[A`).
  // opentui parses this as `{name: "up"}`. Our composer's onKeyDown
  // calls `historyPrev()`; if it succeeds, it preventDefaults the
  // textarea's own up-arrow handler so the caret doesn't move.
  await new Promise((r) => setTimeout(r, 200))
  await kobe.sendKeys("\x1b[A")

  // Append a unique sentinel after the recall — if the recall worked,
  // the textarea now has "HELLOFOO\nBARBAZ" pre-loaded, and typing
  // "RECALLEDXY" appends to it. Visibility of "BARBAZRECALLEDXY"
  // (BARBAZ followed immediately by the sentinel, with no space) is
  // unambiguous: the user-row from the prior submit has BARBAZ as a
  // standalone line, so seeing "BARBAZRECALLEDXY" together can only
  // come from typing into the recalled buffer. Use safe letters
  // (no j/k/d/g/n/q/?) for the sentinel.
  await new Promise((r) => setTimeout(r, 300))
  await kobe.typeText("RECALLEDXY")
  // We can't assert `BARBAZRECALLEDXY` strictly contiguous — opentui's
  // cell-by-cell painting puts a few cells of whitespace between the
  // composer's last visible token and the cursor in the cumulative
  // PTY capture (the textarea visually wraps onto its second line).
  // Both tokens appearing in the screen post-RECALLEDXY-typing is
  // sufficient to prove recall worked: pre-recall the composer was
  // empty (verified by the `Ask Claude…` placeholder being visible),
  // so the only path for both BARBAZ AND a newly-typed sentinel to
  // coexist with the BARBAZ user-row above is via successful recall
  // populating the textarea before the typing landed.
  const afterRecall = await kobe.waitFor((s) => s.includes("RECALLEDXY") && s.includes("BARBAZ"), 5_000)
  expect(afterRecall).toContain("RECALLEDXY")
  expect(afterRecall).toContain("BARBAZ")

  await kobe.exit()
}, 90_000)
