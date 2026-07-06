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
    expect(all.length).toBe(2)

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
    const before = windowIds(env, session)
    expect(before.length).toBe(2)
    const beforePids = tmuxInner(env, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}")
      .stdout.split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1)

    tmux(env, "send-keys", "-t", SESSION, "C-w")
    const closed = await waitUntil(() => windowIds(env, session).length === 1)
    expect(closed).toBe(true)

    tmux(env, "send-keys", "-t", SESSION, "C-w")
    await new Promise((r) => setTimeout(r, 1_500))
    expect(windowIds(env, session).length).toBe(1)
    expect(tmuxInner(env, "has-session", "-t", `=${session}`).code).toBe(0)

    const stillOnSession = new Set(
      tmuxInner(env, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}")
        .stdout.split("\n")
        .map((l) => Number.parseInt(l.trim(), 10)),
    )
    for (const pid of beforePids) {
      if (stillOnSession.has(pid)) continue
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }
  }, 15_000)

  it("ctrl+j / ctrl+k are silent no-ops from the engine pane (no vertical neighbor)", async () => {
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
    const detached = await waitUntil(() => {
      const row = tmuxInner(env, "list-sessions", "-F", "#{session_name}\t#{session_attached}")
        .stdout.split("\n")
        .find((l) => l.startsWith(`${session}\t`))
      return row === `${session}\t0`
    }, 10_000)
    expect(detached).toBe(true)
    expect(tmuxInner(env, "has-session", "-t", `=${session}`).code).toBe(0)
  }, 20_000)
})
