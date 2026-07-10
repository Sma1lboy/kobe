/**
 * Zen mode — a SESSION-GLOBAL collapse of every engine ChatTab down to its
 * engine pane. The on/off intent is persisted app-wide (state/zen.ts); each
 * tmux session mirrors it in ZEN_SESSION_OPTION, and each window records WHICH
 * roles it hid in ZEN_HIDDEN_PANES_OPTION so leaving zen restores exactly
 * those panes and nothing the user had already collapsed themselves.
 */

import { setZenActive, zenIsActive, zenKeepsTasks } from "@/state/zen"
import { getSessionOption, runTmux, sessionExists, setSessionOption } from "@/tmux/client"
import {
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  OPS_PANE_ROLE,
  SHELL_PANE_ROLE,
  TASKS_PANE_ROLE,
  ZEN_HIDDEN_PANES_OPTION,
  ZEN_SESSION_OPTION,
} from "@/tmux/session-layout"
import { resolveShellPane } from "./layout-plan"
import {
  hideTasksPane,
  hideTerminalPane,
  restoreHiddenTasksPane,
  restoreHiddenTerminalPane,
  toggleOpsPane,
} from "./layout-side-panes"
import {
  clearActiveWindowOption,
  displayMessage,
  sessionWindowIds,
  setActiveWindowOption,
  windowHasEnginePane,
  windowOption,
  windowPanes,
} from "./layout-tmux"

/**
 * Zen is a GLOBAL toggle: flip the persisted intent (so every other project's
 * session follows when entered, via {@link syncSessionZen}) and apply it to
 * THIS session right now. The per-session `@kobe_zen` option remains the local
 * "is this session collapsed" record that enter/exit set. Idempotent: a second
 * toggle reverses it across all tabs.
 */
export async function toggleZenSession(session: string): Promise<void> {
  const on = zenIsActive()
  setZenActive(!on)
  if (on) {
    await exitZenSession(session)
    return
  }
  await enterZenSession(session)
}

/**
 * Reconcile one session's layout to the GLOBAL zen intent. Called when entering
 * a session (switchTo / initial attach) so a project you switch to inherits the
 * global on/off state even though its tmux session was never toggled directly.
 * No-op when the session already matches (idempotent) or doesn't exist.
 */
export async function syncSessionZen(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const want = zenIsActive()
  const has = (await getSessionOption(session, ZEN_SESSION_OPTION)).length > 0
  if (want === has) return
  if (want) await enterZenSession(session)
  else await exitZenSession(session)
}

async function enterZenSession(session: string): Promise<void> {
  const windowIds = await sessionWindowIds(session)
  for (const windowId of windowIds) {
    if (!(await windowHasEnginePane(session, windowId))) continue
    if (await windowOption(windowId, ZEN_HIDDEN_PANES_OPTION)) continue // already collapsed
    await enterZenMode(session, windowId)
  }
  await setSessionOption(session, ZEN_SESSION_OPTION, "1")
  await displayMessage(`=${session}`, "kobe: Zen mode on — all tabs")
}

async function exitZenSession(session: string): Promise<void> {
  const windowIds = await sessionWindowIds(session)
  for (const windowId of windowIds) {
    const recorded = await windowOption(windowId, ZEN_HIDDEN_PANES_OPTION)
    if (recorded) await exitZenMode(session, windowId, recorded)
  }
  await runTmux(["set-option", "-u", "-t", session, ZEN_SESSION_OPTION])
  await displayMessage(`=${session}`, "kobe: Zen mode off — all tabs")
}

/**
 * Collapse a freshly built ChatTab if the session is in zen mode, so new tabs
 * (Ctrl+T / quick-create) and tabs the user switches to stay focused. No-op
 * when zen is off or the window is already collapsed. Called by `newChatTab`
 * after its panes are built.
 */
export async function applyZenToNewWindow(session: string, windowId: string): Promise<void> {
  const sessionZen = (await getSessionOption(session, ZEN_SESSION_OPTION)).length > 0
  // Collapse when this session is already in zen OR the GLOBAL intent is on (a
  // freshly created session — e.g. a never-entered task's first window — has no
  // session option yet but should still inherit global zen). Seed the session
  // option so its later tabs collapse too.
  if (!sessionZen && !zenIsActive()) return
  if (!sessionZen) await setSessionOption(session, ZEN_SESSION_OPTION, "1")
  if (await windowOption(windowId, ZEN_HIDDEN_PANES_OPTION)) return
  if (!(await windowHasEnginePane(session, windowId))) return
  await enterZenMode(session, windowId)
}

async function enterZenMode(session: string, windowId: string): Promise<void> {
  const rows = await windowPanes(session, windowId)
  if (!rows) return
  const hidden: string[] = []

  const ops = rows.find((row) => row.role === OPS_PANE_ROLE)
  if (ops) {
    await runTmux(["kill-pane", "-t", ops.paneId])
    hidden.push(OPS_PANE_ROLE)
  }

  const shell = resolveShellPane(rows)
  if (shell) {
    await hideTerminalPane(session, windowId, shell)
    hidden.push(SHELL_PANE_ROLE)
  }

  if (!zenKeepsTasks()) {
    const tasks = rows.find((row) => row.role === TASKS_PANE_ROLE)
    if (tasks) {
      await hideTasksPane(session, windowId, tasks)
      hidden.push(TASKS_PANE_ROLE)
    }
  }

  if (hidden.length === 0) {
    await displayMessage(windowId, "kobe: already focused — nothing to hide")
    return
  }
  await setActiveWindowOption(windowId, ZEN_HIDDEN_PANES_OPTION, hidden.join(","))
  await displayMessage(windowId, "kobe: Zen mode on")
}

async function exitZenMode(session: string, windowId: string, recorded: string): Promise<void> {
  const roles = new Set(recorded.split(",").map((role) => role.trim()))

  // Restore the Tasks rail first (it re-splits off the engine pane on the
  // left), then the file/Ops pane and terminal which key off the engine /
  // each other — mirroring the build order so the geometry lands right.
  if (roles.has(TASKS_PANE_ROLE)) {
    const hiddenPane = await windowOption(windowId, HIDDEN_TASKS_PANE_OPTION)
    if (hiddenPane) await restoreHiddenTasksPane(session, windowId, hiddenPane)
  }
  if (roles.has(OPS_PANE_ROLE)) {
    const rows = await windowPanes(session, windowId)
    if (rows && !rows.some((row) => row.role === OPS_PANE_ROLE)) await toggleOpsPane(session, windowId)
  }
  if (roles.has(SHELL_PANE_ROLE)) {
    const hiddenPane = await windowOption(windowId, HIDDEN_TERMINAL_PANE_OPTION)
    if (hiddenPane) await restoreHiddenTerminalPane(session, windowId, hiddenPane)
  }

  await clearActiveWindowOption(windowId, ZEN_HIDDEN_PANES_OPTION)
  await displayMessage(windowId, "kobe: Zen mode off")
}
