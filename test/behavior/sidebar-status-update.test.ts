/**
 * Behavior test — sidebar reactively reflects task status transitions.
 *
 * This test is the load-bearing proof for the bug fix in
 * `src/orchestrator/index/store.ts` and `src/orchestrator/core.ts`:
 * when the engine drives a task to `done`, the sidebar must redraw
 * the row under the `Done` group with the green `●` badge instead of
 * leaving it under `Backlog` with the muted `○` badge.
 *
 * The original symptom (Jackson's screenshot): a task whose persisted
 * status in `~/.kobe/tasks.json` was `"done"` still rendered under
 * `Backlog` with `○`. The store mutated correctly, but the sidebar's
 * `Task[]` accessor never woke up — the in-memory mirror inside the
 * orchestrator was a stale snapshot.
 *
 * What this test does:
 *   1. Spawn kobe in fake-engine mode.
 *   2. Open the new-task dialog and create one task.
 *   3. Observe the sidebar: the task should appear under `Backlog` with
 *      the muted `○` badge (initial status = backlog).
 *   4. Type a chat prompt + press enter — this triggers `runTask`, the
 *      engine spawns and the pump attaches. We pre-script `done` so the
 *      pump immediately sees terminal completion.
 *   5. POST `/finish` to close the queue cleanly.
 *   6. Wait for the sidebar to redraw: row must move under `Done` with
 *      the green `●` badge.
 *
 * Why this catches the H2 bug specifically:
 *   - On the unfixed code, the orchestrator's `setTasks` is fed a stale
 *     in-memory list because the store's mutations don't notify the
 *     orchestrator. The signal never re-fires; the sidebar memo never
 *     re-runs; the row stays under Backlog with `○`.
 *   - Once the store exposes a `subscribe(cb)` change notifier and the
 *     orchestrator wires it into `tasksSignal()`, every store mutation
 *     immediately refreshes the signal — including mutations from the
 *     pump's `finally` block.
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

/**
 * The PTY captures the cumulative byte stream — every redraw piles
 * into one buffer. opentui repaints partially on each frame
 * (incremental cell-level diffs), so anchoring on the very last
 * occurrence of a marker can land inside a half-painted frame. The
 * reliable signal is: once the orchestrator's task list mutates from
 * X to Y, every subsequent render contains Y, and the substring Y
 * stays embedded somewhere in the cumulative bytes from that point
 * on. So `Y matches anywhere in the buffer` is equivalent to
 * `the renderer has observed the transition at least once`.
 *
 * Negative-match assertions ("the OLD state is no longer visible")
 * are intentionally avoided — partial repaints would race against
 * them.
 */
function bufferContains(screen: string, pattern: RegExp): boolean {
  return pattern.test(screen)
}

/** Wait for the side-channel HTTP server to come up. */
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

let tmpRoot: string
let repo: string
let homeDir: string
let kobe: KobeHandle | null = null

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
})

test("sidebar reactively renders task status transition: backlog → done", async () => {
  // ---- fixtures -------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-sidebar-status-"))
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

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // ---- create a task via the new-task dialog --------------------
  await kobe.sendKeys("n")
  await kobe.waitFor((s) => s.includes("New task"), 5_000)

  const TITLE = "status-transition"
  await kobe.typeText(TITLE)
  await kobe.sendKeys("\t")
  // Clear the default repo input.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  await kobe.sendKeys("\r")

  // ---- assert task initially lives under the Backlog group ------
  // Wait until the buffer shows the new task in the Backlog group
  // with the muted `○` badge. PTY captures collapse whitespace so
  // the badge sits adjacent to the title with no intervening header.
  // We search the whole buffer: once the renderer paints `Backlog 1
  // ○ <title>`, that substring stays visible until the next full
  // repaint. This is the canonical pre-transition signal.
  await kobe.waitFor((s) => bufferContains(s, /Backlog\s*1\s*○\s*\S*status-transition/), 15_000)
  const backlogScreen = await kobe.capture()
  expect(bufferContains(backlogScreen, /Backlog\s*1\s*○\s*\S*status-transition/)).toBe(true)
  // No frame so far should contain `Done 1 ● <title>` — the engine
  // hasn't run yet. This is a meaningful negative against a buffer
  // that we know hasn't been polluted by a later transition because
  // we haven't sent the prompt that starts the engine.
  expect(bufferContains(backlogScreen, /Done\s*1\s*●\s*\S*status-transition/)).toBe(false)

  // ---- pre-script the engine: the next runTask spawns `fake-1`,
  //      which we drive straight to `done`. Then close the stream.
  const doneEvents: EngineEvent[] = [{ type: "done" }]
  await scriptEngine(port, "/script", { sessionId: "fake-1", events: doneEvents })
  await scriptEngine(port, "/finish", { sessionId: "fake-1" })

  // ---- send a chat prompt to start the engine ------------------
  // The chat input is auto-focused once the new-task flow auto-selects
  // the freshly-created task. Pressing enter triggers `runTask`, the
  // pump attaches, sees the pre-scripted `done`, store.update flips the
  // status to `done`, and the orchestrator's tasksSignal must wake the
  // sidebar.
  await kobe.typeText("go")
  await kobe.sendKeys("\r")

  // ---- assert task moved to Done group with green `●` badge -----
  // The orchestrator's pump sees the scripted `done` event, calls
  // `store.update(id, { status: "done" })`, and the store fires its
  // change listener which feeds the orchestrator's task signal. The
  // sidebar's `groupByStatus` re-buckets the row under `Done`, the
  // badge mapping switches the glyph from `○` to `●`, and the row
  // now appears beside the `Done` header in the PTY screen capture.
  //
  // We assert against the buffer because once the renderer has drawn
  // the post-transition state, the substring `Done 1 ● <title>` is
  // permanently embedded somewhere in the cumulative bytes. The bug
  // we are guarding against is the absence of that substring (i.e.
  // the sidebar never repainted after the store mutation).
  // The transition is observable as soon as the renderer paints any
  // frame containing `Done 1 ● <title>`. opentui repaints partially,
  // so adjacent assertions about empty Backlog or absent `○` glyph
  // would race against partial frames; we constrain the assertion to
  // the only signal we can observe deterministically: the post-done
  // sidebar row.
  await kobe.waitFor((s) => bufferContains(s, /Done\s*1\s*●\s*\S*status-transition/), 20_000)
  const doneScreen = await kobe.capture()
  expect(bufferContains(doneScreen, /Done\s*1\s*●\s*\S*status-transition/)).toBe(true)

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 60_000)
