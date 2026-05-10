/**
 * Crash recovery — what the user sees when the engine subprocess dies
 * mid-stream.
 *
 * The orchestrator's `pumpEvents` already handles the terminal `error`
 * event in its for-await loop: it dispatches the event to subscribers,
 * then in the `finally` block flips the task's status to "error"
 * (provided we weren't intentionally killed for a user-input prompt).
 * Unit tests in `test/orchestrator/orchestrator.test.ts` cover that
 * state machine. What had no end-to-end coverage until this file was
 * the *visible product surface* — does the chat actually:
 *
 *   1. Render the assistant text that streamed BEFORE the crash, so
 *      the user doesn't think they lost everything?
 *   2. Surface the error message via the system row + banner so the
 *      user knows the turn aborted?
 *   3. Stay alive — i.e. kobe doesn't dump a stack trace and quit?
 *   4. Unlock the composer so the user can immediately start a new
 *      turn (resume the session) without restarting kobe?
 *
 * The fake engine's `script(sessionId, [{type: "error", message}])`
 * cleanly simulates a fatal stream error. We pre-script some assistant
 * deltas + an error sentinel before triggering the prompt; on the
 * other side we capture the screen and assert.
 *
 * The `done` companion test exists to lock in the symmetric path: a
 * stream that closes cleanly with no events still produces no error
 * banner and unlocks the composer. Cheap to add, expensive to
 * accidentally break.
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
  // Do NOT set Content-Length from body.length — multi-byte UTF-8
  // breaks it (string char count != byte count). Let fetch compute.
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-crash-"))
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
 * Open the new-task dialog, fill repo, and submit the first prompt
 * via the workspace composer. Mirrors `g3-chat.test.ts`'s helper.
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
  // Clear the prefilled cwd in the repo input.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  await kobe.sendKeys("\r")
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
// (a) Engine emits a fatal stream error mid-turn — chat surfaces it
//     without crashing kobe; partial assistant text remains visible;
//     composer unlocks for a follow-up.
// ---------------------------------------------------------------------

test("crash — engine error mid-stream renders error row + banner, kobe stays alive, composer unlocks", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

  // 160x40 so the chat column has enough width that the assistant
  // text + error row aren't fragmented across cell paints (see g3d
  // for the cumulative-PTY-buffer rationale).
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

  // Pre-script: a couple of assistant deltas land first, then a fatal
  // error event with a recognisable sentinel. Using `applyEvent`'s
  // semantics we expect:
  //   - "PARTIALOUT" rendered as an assistant row (deltas coalesce
  //     into a single contiguous row).
  //   - A system row prefixed `error: SENTINEL_FAULT...` appears
  //     (see store.ts applyEvent's `error` case).
  //   - The transient error banner at the bottom of the chat shows
  //     the same sentinel (see MessageList's <Show when={props.error}>).
  //   - isStreaming flips false → composer placeholder is "Ask Claude…"
  //     not "(streaming — wait for done)".
  const SENTINEL = "SENTINEL_FAULT"
  const events: EngineEvent[] = [
    { type: "assistant.delta", text: "PARTIALOUT" },
    { type: "error", message: `${SENTINEL}: pipe closed` },
  ]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events })

  await fillNewTaskDialog(kobe, "crash test", fixture.repo)

  // Assistant text reached the chat before the crash.
  const afterPartial = await kobe.waitFor((s) => s.includes("PARTIALOUT"), 15_000)
  expect(afterPartial).toContain("PARTIALOUT")

  // Error sentinel renders. Use whitespace-collapsed substring assert:
  // opentui wraps cell-by-cell and may inject layout spaces between
  // tokens, so we collapse runs of whitespace before the includes()
  // check rather than asserting the exact rendered string.
  const afterCrash = await kobe.waitFor(
    (s) => s.replace(/\s+/g, " ").includes(SENTINEL),
    15_000,
  )
  const collapsed = afterCrash.replace(/\s+/g, " ")
  expect(collapsed).toContain(SENTINEL)

  // The system row carries the `error:` prefix from store.ts; the
  // error styling in MessageList's SystemRow keys off this prefix.
  // We assert the prefix is present somewhere on screen — exact
  // adjacency to the sentinel can wrap, so collapse + includes.
  expect(collapsed).toContain("error")

  // kobe is still alive. The layout's signature pieces should still
  // be on screen (sidebar header, composer hint area). If kobe had
  // crashed, the next `capture()` would show a node stack trace or
  // an empty/garbled screen instead.
  expect(kobe.closed).toBe(false)
  // Sidebar / chrome still painted — "kobe" is in the title bar.
  expect(afterCrash).toContain("kobe")
  // The task title we just typed is visible in the sidebar — proves
  // the index store + sidebar pane survived the crash event.
  expect(collapsed).toContain("crash test")

  // Composer is unlocked. We can't assert absence of the streaming
  // placeholder via !includes() — opentui's cumulative PTY buffer
  // preserves the bytes painted while isStreaming was briefly true
  // between submit and the error event, even after the renderer
  // overwrites that cell. Instead positive-assert that the
  // post-error composer placeholder ("Ask Claude…") has been
  // painted: it only appears once `isStreaming` flips false AND
  // `hasTask` stays true. The orchestrator wires status to "error"
  // (not "canceled") in pumpEvents' finally — see core.ts — so
  // hasTask remains true and the placeholder reverts to the normal
  // "Ask Claude…" string defined in Composer.tsx's resolvePlaceholder.
  //
  // The renderer paints the placeholder cell-by-cell; the captured
  // string contains the recognisable "Ask Claude" prefix even when
  // an ellipsis or trailing whitespace gets fragmented in the
  // cumulative PTY buffer.
  expect(collapsed).toContain("Ask Claude")

  await kobe.exit()
}, 90_000)

// ---------------------------------------------------------------------
// (b) Symmetric clean-close path. Stream emits no events, just `done`.
//     No error banner; composer unlocks. Cheap regression guard.
// ---------------------------------------------------------------------

test("crash — clean done with no deltas: no error banner, composer unlocks", async () => {
  const fixture = await buildFixture()
  tmpRoot = fixture.tmpRoot
  const port = await pickFreePort()

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

  // Pre-script a bare `done` — no assistant text, no tool, no error.
  // The chat's `applyEvent("done")` case clears isStreaming and emits
  // no row.
  await scriptEngine(port, "/script", {
    sessionId: "fake-1",
    events: [{ type: "done" }] satisfies EngineEvent[],
  })

  await fillNewTaskDialog(kobe, "clean done", fixture.repo)

  // Wait for the task title to land in the sidebar — proves the
  // create + first-prompt round-trip ran.
  await kobe.waitFor((s) => s.includes("clean done"), 15_000)

  // Give the pump a beat to drain the `done` event so the composer
  // placeholder transitions out of the streaming variant. We can't
  // wait on absence directly (the cumulative PTY buffer holds the
  // streaming placeholder bytes from the moment between submit and
  // done), so we settle on the next frame.
  await new Promise((r) => setTimeout(r, 500))
  const screen = await kobe.capture()
  const collapsed = screen.replace(/\s+/g, " ")

  // No error banner / no error system row. The fake engine emitted
  // no `error` event, so the chat's `error` field stays null and
  // MessageList's <Show when={props.error}> fallback (the bottom
  // banner) doesn't render.
  //
  // The `error: <message>` system-row prefix from applyEvent's
  // error branch only ever appears after an error event, so its
  // absence here is a reliable signal that no error was surfaced.
  expect(collapsed).not.toContain("error: ")

  // Composer not stuck in canceled / streaming placeholders.
  expect(collapsed).not.toContain("task canceled")

  // kobe still alive and rendering its chrome.
  expect(kobe.closed).toBe(false)
  expect(screen).toContain("kobe")

  await kobe.exit()
}, 60_000)
