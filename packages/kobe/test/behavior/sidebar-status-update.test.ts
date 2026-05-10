/**
 * Behavior test — sidebar repo grouping is stable across status transitions.
 *
 * Wave 4 W4.A direction shift: the sidebar no longer groups by status.
 * Instead it groups by `Task.repo` — top-level repo headers, nested
 * task rows. The original premise of this test (task moves to a `Done`
 * group when the engine emits `done`) is obsolete because there is no
 * `Done` group anymore.
 *
 * The new contract this test guards:
 *   - When a task transitions backlog → done (engine emits `done`),
 *     the row stays under its **repo header**. The status badge on
 *     the row may flip from `○` (muted) to `●` (success), but the row
 *     does NOT relocate across header boundaries.
 *   - The repo header label (basename of the repo path) and the task
 *     count under it remain visible before AND after the transition.
 *
 * Why this test still exists in the W4.A repo-grouping world:
 *   - The reactive plumbing it originally proved (orchestrator's
 *     `tasksSignal()` waking the sidebar after a `store.update` from
 *     the pump's finally block) is still load-bearing — Wave 4 W4.A
 *     didn't change that wiring. We rewrite the visible-state
 *     assertions to match the new layout while keeping the same
 *     fake-engine + PTY mechanics, so a regression in the orchestrator's
 *     change-notifier wiring still breaks this test.
 *   - It also doubles as the behavioral self-test for the new repo-
 *     grouped sidebar (HARNESS.md §Behavioral self-test): we drive the
 *     real binary, observe the visible repo header + task row, send a
 *     status-changing event, and confirm the row stays put.
 *
 * Mechanics mirror `g2-end-to-end.test.ts`: a fixture repo, fake-engine
 * HTTP side-channel for engine scripting, PTY-driven kobe.
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
 * are intentionally avoided — partial repaints would race against them.
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

test("sidebar keeps a task under its repo header across a backlog → done transition", async () => {
  // ---- fixtures -------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-sidebar-status-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  // We deliberately give the fixture repo a recognizable basename so
  // the sidebar's repo header label assertion is unambiguous. The
  // basename is what `repoLabel()` returns (`path.basename`).
  repo = path.join(tmpRoot, "my-frontend")
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
  await kobe.sendKeys("\x0e") // ctrl+n
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  // Settle so the dialog's prompt input has its focused listener
  // attached before we start typing. The first character can
  // otherwise race with the input's stdin attach.
  await new Promise((r) => setTimeout(r, 250))
  // Defensive clear in case a stray byte lands on the prompt during
  // the dialog mount race. Backspaces on an empty field are no-ops.
  for (let i = 0; i < 4; i++) {
    await kobe.sendKeys("\x7f")
  }

  const TITLE = "status-transition"
  await kobe.typeText(TITLE)
  await kobe.sendKeys("\t")
  await new Promise((r) => setTimeout(r, 250))
  // Clear the default repo input.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  await kobe.sendKeys("\r")

  // ---- assert the task is visible in the sidebar (initial state) ----
  // Wave 4.5 dropped repo grouping. The sidebar shows a flat list under
  // the active "Working session" tab. We anchor on the backlog-status
  // badge `○` followed by the task title — that combination only
  // appears once the row has rendered (the title alone might match the
  // dialog field while the dialog is still open).
  await kobe.waitFor((s) => bufferContains(s, /○\s*\S*status-transition/), 15_000)
  const initialScreen = await kobe.capture()
  expect(initialScreen).toContain("Working session")
  expect(initialScreen).toContain("status-transition")

  // ---- pre-script the engine: drive the next runTask straight to `done` ----
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

  // ---- assert the badge flipped after the transition ----
  // The orchestrator's pump sees the scripted `done` event, calls
  // `store.update(id, { status: "done" })`, and the store fires its
  // change listener which feeds the orchestrator's task signal. The
  // sidebar's badge mapping switches the row's glyph from `○` to `●`
  // (success tone). The row stays in the active view (archived flag
  // hasn't moved).
  await kobe.waitFor((s) => bufferContains(s, /●\s*\S*status-transition/), 20_000)
  const doneScreen = await kobe.capture()
  expect(bufferContains(doneScreen, /●\s*\S*status-transition/)).toBe(true)
  // The task row stays under "Working session" (status transitions
  // don't archive). Archive flag is the only thing that moves a row
  // between views.
  expect(doneScreen).toContain("Working session")
  expect(doneScreen).toContain("status-transition")

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 60_000)
