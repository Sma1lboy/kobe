/**
 * User-facing tmux layout controls for the direct handover workspace — the
 * `runLayoutAction` dispatcher, the temporary middle-workspace splits, and
 * ChatTab window lifecycle (close / engine-exit replacement).
 *
 * These actions are intentionally tmux-local. Middle workspace splits are
 * temporary panes inside the current ChatTab window: they do not touch the
 * task index, do not become a default for future ChatTabs, and disappear when
 * the tmux window/session is rebuilt. The pane hide/restore mechanics live in
 * layout-side-panes.ts, zen mode in layout-zen.ts, the pure split policy in
 * layout-plan.ts, and the shared tmux plumbing in layout-tmux.ts.
 */

import { localSpawnCwd } from "@/exec/resolve"
import { runTmux, runTmuxCapturing, runTmuxSequence, sessionExists, termWindowPaneGroups } from "@/tmux/client"
import { WORKSPACE_AUX_PANE_ROLE, WORKSPACE_SPLIT_MAX_PANES, keepAlive } from "@/tmux/session-layout"
import { planWorkspaceSplit } from "./layout-plan"
import { restoreTasksPane, toggleOpsPane, toggleTasksPane, toggleTerminalPane } from "./layout-side-panes"
import {
  activeSessionWindowCount,
  activeWindowId,
  cleanupHiddenPanesForWindow,
  displayMessage,
  resolveActionWindowId,
  sessionWorktree,
  windowPanes,
} from "./layout-tmux"
import { toggleZenSession } from "./layout-zen"

export type LayoutAction =
  | "workspace-split"
  | "workspace-close"
  | "workspace-reset"
  | "tasks-toggle"
  | "tasks-restore"
  | "ops-toggle"
  | "terminal-toggle"
  | "zen-toggle"
  | "chat-tab-close"

// ---------------------------------------------------------------------------
// Middle workspace splits (temporary aux panes next to the engine pane)
// ---------------------------------------------------------------------------

async function addWorkspaceSplit(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const plan = planWorkspaceSplit(rows)
  if (plan.kind === "missing-engine") {
    await displayMessage(windowId, "kobe: no engine pane in this window")
    return
  }
  if (plan.kind === "maxed") {
    await displayMessage(windowId, `kobe: workspace split limit is ${WORKSPACE_SPLIT_MAX_PANES} panes`)
    return
  }

  const { cwd } = await sessionWorktree(session)
  const { code, stdout } = await runTmuxCapturing([
    "split-window",
    plan.direction,
    "-t",
    plan.targetPane,
    "-l",
    "50%",
    "-c",
    localSpawnCwd(cwd),
    "-P",
    "-F",
    "#{pane_id}",
    keepAlive("true"),
  ])
  const paneId = stdout.trim()
  if (code !== 0 || !paneId) return
  await runTmuxSequence([
    ["set-option", "-p", "-t", paneId, "@kobe_role", WORKSPACE_AUX_PANE_ROLE],
    ["select-pane", "-t", paneId],
  ])
}

async function closeWorkspaceSplit(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const aux = rows.filter((row) => row.role === WORKSPACE_AUX_PANE_ROLE)
  if (aux.length === 0) {
    await displayMessage(windowId, "kobe: no workspace split to close")
    return
  }
  const activeAux = aux.find((row) => row.active)
  const target = activeAux ?? aux[aux.length - 1]
  if (!target) return
  await runTmux(["kill-pane", "-t", target.paneId])
}

async function resetWorkspaceSplits(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const aux = rows.filter((row) => row.role === WORKSPACE_AUX_PANE_ROLE)
  if (aux.length === 0) {
    await displayMessage(windowId, "kobe: no workspace splits to reset")
    return
  }
  await runTmuxSequence(aux.map((row) => ["kill-pane", "-t", row.paneId]))
}

// ---------------------------------------------------------------------------
// ChatTab window lifecycle
// ---------------------------------------------------------------------------

/**
 * `kill-window` only SIGHUPs panes; engine CLIs (claude) swallow HUP and
 * leak to init with a revoked tty (#205 class — issue #14). SIGTERM the
 * window's pane groups first, the same ladder `killSession` uses.
 */
async function killWindowWithPaneGroups(windowId: string): Promise<void> {
  await termWindowPaneGroups(windowId)
  await runTmux(["kill-window", "-t", windowId])
}

async function closeChatTab(session: string, windowId: string): Promise<void> {
  if ((await activeSessionWindowCount(session)) <= 1) {
    await displayMessage(windowId, "Cannot close the only ChatTab")
    return
  }
  await cleanupHiddenPanesForWindow(session, windowId)
  await killWindowWithPaneGroups(windowId)
}

/**
 * Tear down a chat tab whose engine the user fully exited (engine process
 * exited → fallback shell → user typed `exit`). Invoked by `kobe engine-tab-exit`
 * from that pane's own keepAlive `onExit` (see `engineTabExitCleanup`).
 *
 * Multi-tab: close this window; tmux moves the client to a sibling tab.
 * Only tab: do NOT kill the task's last window (that would end the whole task
 * session and orphan the client) — instead open a FRESH engine tab and then
 * close the gutted one, so the task always has a live engine. The old window id
 * is captured BEFORE `newChatTab` runs, because creating the new window makes it
 * the active one; we only kill the old window once a new active window exists.
 */
export async function engineTabExit(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const oldWindowId = await activeWindowId(session)
  if (!oldWindowId) return
  if ((await activeSessionWindowCount(session)) > 1) {
    await cleanupHiddenPanesForWindow(session, oldWindowId)
    await killWindowWithPaneGroups(oldWindowId)
    return
  }
  // Only tab → replace it. Dynamic import keeps the heavy chattab module (and
  // its session-create surface) out of this module's static graph — CLI entry
  // points import layout-actions for the dispatcher alone.
  const { newChatTab } = await import("./chattab")
  await newChatTab(session)
  // Kill the gutted window only if a fresh active window actually took over —
  // otherwise newChatTab failed and we must not kill the task's last window.
  if ((await activeWindowId(session)) !== oldWindowId) {
    await cleanupHiddenPanesForWindow(session, oldWindowId)
    await killWindowWithPaneGroups(oldWindowId)
  }
}

export async function runLayoutAction(
  session: string,
  action: LayoutAction,
  opts: { readonly windowId?: string } = {},
): Promise<void> {
  if (!(await sessionExists(session))) return
  const windowId = await resolveActionWindowId(session, opts.windowId)
  if (!windowId) return
  switch (action) {
    case "workspace-split":
      await addWorkspaceSplit(session, windowId)
      return
    case "workspace-close":
      await closeWorkspaceSplit(session, windowId)
      return
    case "workspace-reset":
      await resetWorkspaceSplits(session, windowId)
      return
    case "tasks-toggle":
      await toggleTasksPane(session, windowId)
      return
    case "tasks-restore":
      await restoreTasksPane(session, windowId)
      return
    case "ops-toggle":
      await toggleOpsPane(session, windowId)
      return
    case "terminal-toggle":
      await toggleTerminalPane(session, windowId)
      return
    case "zen-toggle":
      // Zen is session-global: ignore the per-window target and toggle every tab.
      await toggleZenSession(session)
      return
    case "chat-tab-close":
      await closeChatTab(session, windowId)
      return
  }
}
