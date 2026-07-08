/**
 * Direct-tmux handover chord pins — one boot (like tui-smoke.test.ts),
 * multiple send-keys/capture-pane assertions against kobe's OWN tmux socket
 * (`tmuxInner`), driven through the OUTER attached client the same way a
 * real terminal would (`tmux(env, "send-keys", ...)` on the pane running
 * `kobe`). Claims pinned (see `src/tui/panes/terminal/tmux.ts` header comment
 * + `docs/KEYBINDINGS.md` "Direct-tmux handover keys" table):
 *
 *   - `ctrl+t` opens a same-engine ChatTab (new window, same 4-pane layout,
 *     its own live engine pane).
 *   - `ctrl+]` / `ctrl+[` cycle ChatTab windows (tmux `next-window` /
 *     `previous-window` — these WRAP, unlike pane focus).
 *   - `ctrl+w` closes the current ChatTab window, but never the final one
 *     (tmux.ts: "refuses to close the final window... the user intent here
 *     is 'close this ChatTab', not 'destroy the Task handover'").
 *   - `ctrl+j` / `ctrl+k` are silent no-ops from a pane with no vertical
 *     neighbor (the engine pane spans full height) — #192's "random-feeling"
 *     source B, the edge guard in `focusBindCommand`.
 *   - the zoom exemption in `focusBindCommand`: a zoomed pane reports every
 *     `pane_at_*` edge flag as 1, so the `window_zoomed_flag` branch bypasses
 *     the edge guard entirely and falls through to plain `select-pane`,
 *     un-zooming AND moving — the tmux.ts comment's "verified live" claim,
 *     now automated.
 *   - `ctrl+q` two-stage: first press focuses the Tasks pane, second press
 *     (from Tasks) detaches the attached client while the session keeps
 *     running.
 *
 * `ctrl+q`'s second press ends the OUTER attached client (and, since this
 * suite's outer session has no other pane, the outer tmux SERVER itself) —
 * so that test runs last in this file; every other assertion runs before it
 * against the one shared boot.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type BehaviorEnv,
  makeBehaviorEnv,
  makeScratchRepo,
  tmux,
  tmuxAvailable,
  tmuxInner,
  waitForScreen,
} from "./harness.ts"

const SESSION = "chords"

interface PaneRow {
  windowId: string
  paneId: string
  role: string
  active: boolean
  zoomed: boolean
}

function taskSessionName(env: BehaviorEnv): string {
  const name = tmuxInner(env, "list-sessions", "-F", "#{session_name}")
    .stdout.split("\n")
    .find((s) => s.startsWith("kobe-") && s !== "kobe-home")
  if (!name) throw new Error("no task session found on the inner socket")
  return name
}

/** Every pane across every window of the session (`-s`), with role/active/zoom. */
function allPanes(env: BehaviorEnv, session: string): PaneRow[] {
  return tmuxInner(
    env,
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    "#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{pane_active}\t#{window_zoomed_flag}",
  )
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => {
      const [windowId, paneId, role, active, zoomed] = line.split("\t")
      return { windowId, paneId, role, active: active === "1", zoomed: zoomed === "1" } as PaneRow
    })
}

function windowIds(env: BehaviorEnv, session: string): string[] {
  return tmuxInner(env, "list-windows", "-t", `=${session}`, "-F", "#{window_id}").stdout.split("\n").filter(Boolean)
}

function activeWindowId(env: BehaviorEnv, session: string): string {
  const row = tmuxInner(env, "list-windows", "-t", `=${session}`, "-F", "#{window_active}\t#{window_id}")
    .stdout.split("\n")
    .find((l) => l.startsWith("1\t"))
  return row?.split("\t")[1] ?? ""
}

/** The active pane's row within the CURRENT window (matches tui-smoke's `activeRole`). */
function activePane(env: BehaviorEnv, session: string): PaneRow | undefined {
  return allPanes(env, session).find((p) => p.active && p.windowId === activeWindowId(env, session))
}

function paneByRole(env: BehaviorEnv, session: string, role: string, windowId?: string): PaneRow | undefined {
  return allPanes(env, session).find((p) => p.role === role && (!windowId || p.windowId === windowId))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return predicate()
}

describe.skipIf(!tmuxAvailable())("tmux direct-handover chords (behavior)", () => {
  let env: BehaviorEnv
  let session: string

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    const repo = await makeScratchRepo(env)
    const boot = tmux(env, "new-session", "-d", "-x", "180", "-y", "45", "-s", SESSION, `cd ${repo} && kobe`)
    expect(boot.code).toBe(0)
    await waitForScreen(env, SESSION, (s) => s.includes("KOBE v") && s.includes("fake-claude ready"), 45_000)
    session = taskSessionName(env)
  }, 60_000)

  afterAll(async () => {
    await env.dispose()
  })

  it("ctrl+t opens a new same-engine ChatTab window with its own live engine pane", async () => {
    const before = new Set(windowIds(env, session))
    expect(before.size).toBe(1)

    tmux(env, "send-keys", "-t", SESSION, "C-t")
    const opened = await waitUntil(() => windowIds(env, session).length === before.size + 1)
    expect(opened).toBe(true)

    const after = windowIds(env, session)
    const newWindow = after.find((w) => !before.has(w))
    expect(newWindow).toBeTruthy()
    // New window carries the full 4-pane workspace, not a bare shell. The
    // window itself exists as soon as tmux splits it, but the `@kobe_role`
    // tags land a beat later (buildPanesAround's follow-up set-option calls),
    // so poll for the full role set rather than asserting on the first read.
    const rolesInNewWindow = () =>
      new Set(
        allPanes(env, session)
          .filter((p) => p.windowId === newWindow)
          .map((p) => p.role),
      )
    const tagged = await waitUntil(() => rolesInNewWindow().size === 4)
    expect(tagged).toBe(true)
    expect(rolesInNewWindow()).toEqual(new Set(["tasks", "claude", "ops", "shell"]))

    const claudePane = paneByRole(env, session, "claude", newWindow)
    expect(claudePane).toBeTruthy()
    const ready = await waitUntil(() =>
      tmuxInner(env, "capture-pane", "-t", claudePane?.paneId as string, "-p").stdout.includes("fake-claude ready"),
    )
    expect(ready).toBe(true)
  }, 20_000)

  it("ctrl+] / ctrl+[ cycle the active ChatTab window (wraps, unlike pane focus)", async () => {
    const start = activeWindowId(env, session)
    const all = windowIds(env, session)
    expect(all.length).toBe(2) // carried over from the ctrl+t test

    tmux(env, "send-keys", "-t", SESSION, "C-]")
    const movedForward = await waitUntil(() => activeWindowId(env, session) !== start)
    expect(movedForward).toBe(true)
    const mid = activeWindowId(env, session)
    expect(mid).not.toBe(start)

    tmux(env, "send-keys", "-t", SESSION, "C-[")
    const movedBack = await waitUntil(() => activeWindowId(env, session) === start)
    expect(movedBack).toBe(true)
  }, 15_000)

  it("ctrl+w closes the current ChatTab window; the final window is protected", async () => {
    // Leave the active window on the SECOND (non-@0) window before closing —
    // closing @0 (the session's very first window) is the same operation but
    // asserting on "count went from 2 to 1" doesn't care which one dies.
    const before = windowIds(env, session)
    expect(before.length).toBe(2)
    // `chat-tab-close` (layout-actions.ts's `closeChatTab`) now SIGTERMs the
    // window's pane groups (`termWindowPaneGroups`, the same ladder
    // `killSession` uses) before `kill-window` — regression pin for the #205
    // leak class: tmux's own teardown only SIGHUPs panes, and the fake
    // `claude` shim traps SIGHUP (same as the real CLI), so without the
    // SIGTERM ladder its process would survive the window close, reparented
    // to init, invisible to `list-panes` once the window is gone.
    const beforePids = tmuxInner(env, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}")
      .stdout.split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1)

    tmux(env, "send-keys", "-t", SESSION, "C-w")
    const closed = await waitUntil(() => windowIds(env, session).length === 1)
    expect(closed).toBe(true)

    // No orphan left behind: every pid that was on the closed window's panes
    // is actually dead, not just detached from `list-panes`.
    const stillOnSession = new Set(
      tmuxInner(env, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}")
        .stdout.split("\n")
        .map((l) => Number.parseInt(l.trim(), 10)),
    )
    const closedPids = beforePids.filter((pid) => !stillOnSession.has(pid))
    expect(closedPids.length).toBeGreaterThan(0)
    const allDead = await waitUntil(() => {
      return closedPids.every((pid) => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      })
    }, 5_000)
    expect(allDead).toBe(true)

    // Final window: ctrl+w must be a no-op, not a session-kill.
    tmux(env, "send-keys", "-t", SESSION, "C-w")
    await new Promise((r) => setTimeout(r, 1_500))
    expect(windowIds(env, session).length).toBe(1)
    expect(tmuxInner(env, "has-session", "-t", `=${session}`).code).toBe(0)
  }, 15_000)

  it("ctrl+j / ctrl+k are silent no-ops from the engine pane (no vertical neighbor)", async () => {
    // Pin a known starting pane directly (not via send-keys) so this test
    // doesn't depend on what the window/close tests above left focused.
    const claudePane = paneByRole(env, session, "claude")
    expect(claudePane).toBeTruthy()
    tmuxInner(env, "select-pane", "-t", claudePane?.paneId as string)

    tmux(env, "send-keys", "-t", SESSION, "C-j")
    await new Promise((r) => setTimeout(r, 1_000))
    expect(activePane(env, session)?.role).toBe("claude")

    tmux(env, "send-keys", "-t", SESSION, "C-k")
    await new Promise((r) => setTimeout(r, 1_000))
    expect(activePane(env, session)?.role).toBe("claude")
  }, 15_000)

  it("zoom exemption: resize-pane -Z then ctrl+h un-zooms AND moves focus", async () => {
    // Zoom the Tasks pane (the true left edge) — without the exemption,
    // ctrl+h there is normally a guarded no-op (see tui-smoke.test.ts); a
    // ZOOMED pane reports every pane_at_* edge as 1, so this is the one
    // state where the guard would turn ctrl+h into a dead key without it.
    const tasksPane = paneByRole(env, session, "tasks")
    expect(tasksPane).toBeTruthy()
    tmuxInner(env, "select-pane", "-t", tasksPane?.paneId as string)
    const zoomResult = tmuxInner(env, "resize-pane", "-Z", "-t", session)
    expect(zoomResult.code).toBe(0)
    expect(activePane(env, session)?.zoomed).toBe(true)
    expect(activePane(env, session)?.role).toBe("tasks")

    tmux(env, "send-keys", "-t", SESSION, "C-h")
    const moved = await waitUntil(() => activePane(env, session)?.role !== "tasks")
    expect(moved).toBe(true)
    expect(activePane(env, session)?.zoomed).toBe(false)
  }, 15_000)

  it("ctrl+q is two-stage: focuses Tasks first, detaches the client on the second press", async () => {
    const claudePane = paneByRole(env, session, "claude")
    expect(claudePane).toBeTruthy()
    tmuxInner(env, "select-pane", "-t", claudePane?.paneId as string)
    expect(activePane(env, session)?.role).toBe("claude")

    const attachedBefore = tmuxInner(env, "list-sessions", "-F", "#{session_name}\t#{session_attached}")
      .stdout.split("\n")
      .find((l) => l.startsWith(`${session}\t`))
    expect(attachedBefore).toBe(`${session}\t1`)

    tmux(env, "send-keys", "-t", SESSION, "C-q")
    const focusedTasks = await waitUntil(() => activePane(env, session)?.role === "tasks")
    expect(focusedTasks).toBe(true)

    tmux(env, "send-keys", "-t", SESSION, "C-q")
    // The client detaches — the session's attached-client count is the
    // observable signal (the harness never truly "attaches" a client, so we
    // assert on this rather than an unattached outer TTY's screen content).
    const detached = await waitUntil(() => {
      const row = tmuxInner(env, "list-sessions", "-F", "#{session_name}\t#{session_attached}")
        .stdout.split("\n")
        .find((l) => l.startsWith(`${session}\t`))
      return row === `${session}\t0`
    }, 10_000)
    expect(detached).toBe(true)
    // Detach, not destroy: the task's tmux session keeps running.
    expect(tmuxInner(env, "has-session", "-t", `=${session}`).code).toBe(0)
  }, 20_000)
})
