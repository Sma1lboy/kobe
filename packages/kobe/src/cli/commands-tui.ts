/**
 * TUI/tmux pane-host subcommands — split out of `cli/index.ts` (which was
 * over the repo's 500-line file-size cap) purely mechanically: same
 * behavior, moved verbatim. These are internal subcommands fired by tmux
 * key bindings / hooks inside a task session, or standalone full-window
 * page hosts (settings/worktrees/help-page/new-task/update-page/…) opened
 * as new tmux windows — never meant for direct user invocation.
 */

import { ALL_VENDORS, type VendorId, coerceVendorId } from "../types/vendor.ts"

interface OpsFlags {
  taskId?: string
  worktree?: string
  targetPane?: string
  /** Task engine vendor — selects which transcript store the activity badge polls. */
  vendor?: string
  /** When set, render the full-width file preview for this rel path instead of the FileTree. */
  preview?: string
  /** tmux session name (used by `new-chattab`). */
  session?: string
  /** Default repo to pre-select (used by `new-task`). */
  repo?: string
  /** Initial task row to select when a tmux Tasks pane starts. */
  initialTaskId?: string
  /** Internal layout action, used by `kobe layout`. */
  action?: string
  /** tmux window id, used by `kobe layout --action chat-tab-close`. */
  windowId?: string
  /** Client terminal width (cells), used by `kobe resync-window`. */
  cols?: string
  /** Client terminal height (cells), used by `kobe resync-window`. */
  rows?: string
  /** tmux `#{status}` value of the resized client, used by `kobe resync-window`. */
  status?: string
  /** tmux client name, used by `kobe resync-window`. */
  client?: string
  /** Task title for the `kobe history` pane header. */
  title?: string
}

/** Parse `kobe ops` / `kobe new-chattab` flags. */
function parseOpsFlags(argv: readonly string[]): OpsFlags {
  const flags: OpsFlags = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) continue
    if (flag === "--task-id") {
      flags.taskId = value
      i++
    } else if (flag === "--worktree") {
      flags.worktree = value
      i++
    } else if (flag === "--target-pane") {
      flags.targetPane = value
      i++
    } else if (flag === "--vendor") {
      flags.vendor = value
      i++
    } else if (flag === "--preview") {
      flags.preview = value
      i++
    } else if (flag === "--session") {
      flags.session = value
      i++
    } else if (flag === "--repo") {
      flags.repo = value
      i++
    } else if (flag === "--initial-task-id") {
      flags.initialTaskId = value
      i++
    } else if (flag === "--action") {
      flags.action = value
      i++
    } else if (flag === "--window") {
      flags.windowId = value
      i++
    } else if (flag === "--cols") {
      flags.cols = value
      i++
    } else if (flag === "--rows") {
      flags.rows = value
      i++
    } else if (flag === "--status") {
      flags.status = value
      i++
    } else if (flag === "--client") {
      flags.client = value
      i++
    } else if (flag === "--title") {
      flags.title = value
      i++
    }
  }
  return flags
}

/**
 * Dispatch a TUI/tmux pane-host subcommand. Returns `true` if `subcommand`
 * matched (and was handled) — `cli/index.ts`'s `main()` falls through to
 * its unknown-command error / default TUI launch when this returns `false`.
 */
export async function dispatchTuiCommand(subcommand: string | undefined, rest: readonly string[]): Promise<boolean> {
  if (subcommand === "new-chattab") {
    // Ctrl+T handler from inside a task's tmux session — opens a new
    // chat-tab window. Reads the session name from `--session`; an
    // optional `--vendor` comes from the engine-choice tmux prompt.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe new-chattab: --session <name> is required")
      process.exit(2)
    }
    // Ctrl+T / Ctrl+Shift+T fire from the session-global root table, so they
    // reach surface pages (new-task / settings / …) too — where opening a new
    // chat tab would yank the user off a half-filled dialog. No-op there.
    const { windowIsSurface } = await import("../tmux/client.ts")
    if (await windowIsSurface(session)) return true
    let vendor: VendorId | undefined
    if (flags.vendor !== undefined) {
      // Accept any built-in (claude/codex/copilot) OR a registered custom
      // engine id (Settings → Engines). A genuine typo is rejected — but
      // VISIBLY: this runs under tmux `run-shell`, so a bare `process.exit(2)`
      // produces no new tab and no feedback. Surface the error via tmux
      // `display-message` so the user sees "unknown engine '…'" instead of
      // silence (the engine-choice prompt now ends with `…`, implying the list
      // is open, so a custom id is a legitimate entry).
      const typed = flags.vendor.trim()
      const { getCustomEngineIds } = await import("../state/repos.ts")
      const { isBuiltinVendor } = await import("../types/vendor.ts")
      const accepted = isBuiltinVendor(typed) || getCustomEngineIds().includes(typed)
      if (!accepted) {
        const knownList = [...ALL_VENDORS, ...getCustomEngineIds()].join(", ")
        const msg = `kobe: unknown engine '${typed}' (known: ${knownList})`
        const { runTmux } = await import("../tmux/client.ts")
        await runTmux(["display-message", "-t", session, msg])
        console.error(msg)
        process.exit(2)
      }
      vendor = typed as VendorId
      // newChatTab records the pick as the project's last-active engine.
    }
    const { newChatTab } = await import("../tui/panes/terminal/tmux.ts")
    await newChatTab(session, vendor)
    return true
  }
  if (subcommand === "engine-tab-exit") {
    // Fired from an engine pane's keepAlive `onExit` (see engineTabExitCleanup)
    // after the user exits the post-engine fallback shell. Closes this chat tab,
    // or — when it's the task's only tab — replaces it with a fresh engine tab so
    // the task session never goes empty. Reads the baked-in `--session`.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe engine-tab-exit: --session <name> is required")
      process.exit(2)
    }
    const { engineTabExit } = await import("../tui/panes/terminal/layout-actions.ts")
    await engineTabExit(session)
    return true
  }
  if (subcommand === "kill-sessions") {
    // Dev/reset helper: tear down kobe's entire tmux server (all task
    // sessions on the `-L kobe` socket). Use after changing Tasks-pane /
    // Ops-pane / engine code so a long-lived session isn't still running
    // an OLD version of those panes. Does NOT touch the user's own tmux
    // (different socket) or the daemon (run `kobe daemon restart` for
    // that). No-op when no kobe server is running.
    const { runTmux, termAllPaneGroups, KOBE_TMUX_SOCKET } = await import("../tmux/client.ts")
    // TERM every pane group first: engines and helpers catch tmux's HUP
    // without exiting, so a bare kill-server leaked them all to launchd.
    await termAllPaneGroups()
    const code = await runTmux(["kill-server"])
    console.log(
      code === 0
        ? `kobe: killed all tmux sessions on the \`${KOBE_TMUX_SOCKET}\` socket`
        : `kobe: no tmux sessions to kill on the \`${KOBE_TMUX_SOCKET}\` socket`,
    )
    return true
  }
  if (subcommand === "quick-create") {
    // Ctrl+F handler from inside a task's tmux session — focuses the
    // Tasks pane and opens its new-task dialog. Reads `--session`.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe quick-create: --session <name> is required")
      process.exit(2)
    }
    const { quickCreate } = await import("../tui/panes/terminal/tmux.ts")
    await quickCreate(session)
    return true
  }
  if (subcommand === "focus-tasks") {
    // First stage of two-stage Ctrl+Q from inside a task's tmux session:
    // focus the current window's Tasks pane, restoring it first if the rail is
    // hidden. The if-shell binding invokes this only when it should not detach
    // directly. Reads `--session` plus the source `--window` when fired by tmux.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe focus-tasks: --session <name> is required")
      process.exit(2)
    }
    const { windowIsSurface } = await import("../tmux/client.ts")
    // Ctrl+Q's else-branch (back-to-tasks) reaches surface pages too — a
    // surface window has no Tasks pane and the user is mid-dialog, so no-op.
    if (flags.windowId && (await windowIsSurface(flags.windowId))) return true
    const { selectTasksPane } = await import("../tui/panes/terminal/tmux.ts")
    await selectTasksPane(session, { windowId: flags.windowId })
    return true
  }
  if (subcommand === "heal-layout") {
    // `window-resized` + `pane-exited` tmux hook handler: re-pin the session's
    // Tasks-rail width + right-column geometry to the shared globals. Fixes the
    // first-attach reflow (the first session is built before any client is
    // attached, so tmux reflows its panes when `attach` lands the real terminal
    // size), any live terminal resize, and the pane-close reflow (exiting a
    // workspace-split terminal hands its cells to a neighbour, knocking the rail /
    // right column off their pinned geometry). No-op for the home/role-less
    // session. Reads `--session`.
    //
    // A live resize fires this hook many times in a burst; `coalesceLayoutWork`
    // trailing-debounces so the burst collapses to ONE heal (no concurrent
    // `-b` thrash, no per-event tmux round-trip storm). The pre-attach heal in
    // `prepareWindowForAttach` is a DIRECT call, so the first frame is still
    // synchronous — the debounce only affects the live-resize hook path.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe heal-layout: --session <name> is required")
      process.exit(2)
    }
    const { healSessionLayout } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "heal", () => healSessionLayout(session))
    return true
  }
  if (subcommand === "resync-window") {
    // `client-resized` tmux hook handler: re-pin the active window to the size of
    // the client whose terminal just changed, then heal the rail. Covers the GROW
    // direction that `window-resized` / `heal-layout` miss — the pre-attach
    // `resize-window` left the window in `manual` sizing, so a live terminal grow
    // never fires `window-resized` (see resyncWindowToClient). Client dims arrive
    // as args; coalesced so a resize-drag's event burst collapses to one re-pin.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe resync-window: --session <name> is required")
      process.exit(2)
    }
    const cols = Number.parseInt(flags.cols ?? "", 10)
    const rows = Number.parseInt(flags.rows ?? "", 10)
    const size =
      Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0 ? { columns: cols, rows } : null
    const { resyncWindowToClient } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "resync", () =>
      resyncWindowToClient(session, { size, status: flags.status, clientName: flags.client }),
    )
    return true
  }
  if (subcommand === "capture-layout") {
    // `window-layout-changed` tmux hook handler: persist a manual rail /
    // right-column drag into the shared global the moment it happens, so a
    // later terminal resize (whose `heal-layout` re-pins to the global) can't
    // discard a drag the user hadn't yet committed by switching tasks.
    //
    // `window-layout-changed` ALSO fires on a terminal-resize reflow (and on
    // the heal's own `resize-pane`), where the rail is proportionally blown up
    // and must NOT be captured. The `genAgeMs(..., "resize")` guard skips
    // capture while a resize/heal is in flight — every heal path stamps the
    // `resize` recency marker (healWorkspaceLayout + the pre-switch/attach
    // resizes), not just the coalesced hook. `captureGlobalLayoutOnDrag`'s own
    // gate excludes zoom / half-built layouts.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe capture-layout: --session <name> is required")
      process.exit(2)
    }
    const { captureGlobalLayoutOnDrag } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork, genAgeMs, RESIZE_GUARD_MS } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "capture", async () => {
      // Re-check AFTER winning the debounce: a resize may have begun during the
      // trailing wait, in which case its heal owns the geometry — not us.
      if (genAgeMs(session, "resize") < RESIZE_GUARD_MS) return
      await captureGlobalLayoutOnDrag(session)
    })
    return true
  }
  if (subcommand === "layout") {
    // Internal tmux session layout controls fired by prefix layout bindings.
    // Reads `--session`, source `--window`, and a narrow `--action` enum so
    // async run-shell handlers act on the ChatTab where the key was pressed.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe layout: --session <name> is required")
      process.exit(2)
    }
    const action = flags.action
    const valid = new Set([
      "workspace-split",
      "workspace-close",
      "workspace-reset",
      "tasks-toggle",
      "tasks-restore",
      "ops-toggle",
      "terminal-toggle",
      "zen-toggle",
      "chat-tab-close",
    ])
    if (!action || !valid.has(action)) {
      console.error(
        "kobe layout: --action must be one of workspace-split, workspace-close, workspace-reset, tasks-toggle, tasks-restore, ops-toggle, terminal-toggle, zen-toggle, chat-tab-close",
      )
      process.exit(2)
    }
    // `tasks-restore` is the one action reachable from a session-global no-prefix
    // chord (Ctrl+h's focus-left edge command). A surface window (settings /
    // new-task / …) is always single-pane, so its active pane is at the left edge
    // and the edge command fires — but a surface has no Tasks pane, so
    // `restoreTasksPane` would `createTasksPane`, splitting the dialog and
    // injecting a Tasks rail. Guard it the same way focus-tasks / new-chattab do.
    if (action === "tasks-restore" && flags.windowId) {
      const { windowIsSurface } = await import("../tmux/client.ts")
      if (await windowIsSurface(flags.windowId)) return true
    }
    const { runLayoutAction } = await import("../tui/panes/terminal/tmux.ts")
    await runLayoutAction(session, action as import("../tui/panes/terminal/tmux.ts").LayoutAction, {
      windowId: flags.windowId,
    })
    return true
  }
  if (subcommand === "tasks") {
    // The Tasks pane (left side of a task's tmux session) — a task list
    // that `switch-client`s between sessions. Restored after the Solid
    // removal (7a5b878d) dropped it without a React port: the tmux
    // product path spawns `kobe tasks` in every session's rail.
    const flags = parseOpsFlags(rest)
    const { startTasksPane } = await import("../tui-react/tasks-pane/host.tsx")
    await startTasksPane({ initialTaskId: flags.initialTaskId })
    return true
  }
  if (subcommand === "new-task") {
    // The new-task flow as a standalone full-window page (the default
    // `chattab` settings surface). Opened by `openNewTaskTab`; reuses the
    // same NewTaskDialog the in-pane overlay uses and performs the
    // create/adopt against its own daemon connection before exiting.
    const flags = parseOpsFlags(rest)
    const { startNewTaskHost } = await import("../tui-react/new-task/host.tsx")
    await startNewTaskHost({ defaultRepo: flags.repo })
    return true
  }
  if (subcommand === "quick-task") {
    // The prompt-only quick-create page, opened in its own window by
    // `quickCreate` (the `<prefix> f` / `kobe quick-create` handler). Asks
    // for only a prompt and fills the rest from the firing task's defaults.
    // Reads `--session` to resolve those defaults.
    const flags = parseOpsFlags(rest)
    const { startQuickTaskHost } = await import("../tui-react/quick-task/host.tsx")
    await startQuickTaskHost({ session: flags.session })
    return true
  }
  if (subcommand === "update-page") {
    // Internal full-window update surface opened from the tmux-native
    // Tasks pane. `kobe update` remains the shell updater; this page
    // presents the version/release context and hands off to that updater.
    const { startUpdateHost } = await import("../tui-react/update/host.tsx")
    await startUpdateHost()
    return true
  }
  if (subcommand === "settings") {
    // The Settings page as a standalone full-window surface (the default
    // `chattab` settings surface). Opened by `openSettingsTab` as a new
    // tmux window; reuses the same SettingsDialog the in-pane overlay
    // uses. Dynamic import keeps opentui off the other subcommands' path.
    const { startSettingsHost } = await import("../tui-react/settings/host.tsx")
    await startSettingsHost()
    return true
  }
  if (subcommand === "worktrees") {
    // The worktree-management page as a standalone full-window surface
    // (mirrors `settings`). Opened by `openWorktreesTab` as a new tmux
    // window. Internal — not typed by users, only ever spawned by the
    // tab opener.
    const { startWorktreesHost } = await import("../tui-react/worktrees/host.tsx")
    await startWorktreesHost()
    return true
  }
  if (subcommand === "help-page") {
    // The F1 keybindings help as a standalone full-window surface
    // (distinct from `kobe help`, which prints CLI usage). Opened by
    // `openHelpTab` as a new tmux window; reuses the same HelpDialog
    // the in-pane overlay uses.
    const { startHelpHost } = await import("../tui-react/help/host.tsx")
    await startHelpHost()
    return true
  }
  if (subcommand === "history") {
    // The read-only engine-history pane (beta) — launched into the engine
    // pane slot instead of the live engine when an archived task is opened
    // with `experimental.archivedHistoryPreview` on. Its own process inside
    // the tmux pane; reads the vendor transcript store by worktree path, so
    // it works even when the worktree is gone. Dynamic import keeps opentui
    // out of the other subcommands' startup graph.
    const flags = parseOpsFlags(rest)
    if (!flags.worktree) {
      console.error("kobe history: --worktree <path> is required")
      process.exit(2)
    }
    const { startHistoryHost } = await import("../tui-react/history/host.tsx")
    await startHistoryHost({
      worktree: flags.worktree,
      vendor: coerceVendorId(flags.vendor),
      title: flags.title,
      // Boolean flag (no value) — the shared parseOpsFlags is value-based and
      // would skip it, so read it straight off the argv.
      live: rest.includes("--live"),
    })
    return true
  }
  if (subcommand === "ops") {
    // The Ops pane (right side of the per-task tmux session). Runs in
    // its own process inside the tmux pane; mounts the v0.5 FileTree
    // against the task's worktree. Dynamic import keeps opentui out of
    // the other subcommands' startup graph.
    const flags = parseOpsFlags(rest)
    if (!flags.worktree) {
      console.error("kobe ops: --worktree <path> is required")
      process.exit(2)
    }
    // `--preview <rel>` → full-width syntax-highlighted file/diff view
    // (opentui `<diff>` / `<code>`). Otherwise the FileTree browser.
    if (flags.preview) {
      const { startOpsPreview } = await import("../tui-react/ops/preview.tsx")
      await startOpsPreview({ worktree: flags.worktree, relPath: flags.preview })
      return true
    }
    const { startOpsHost } = await import("../tui-react/ops/host.tsx")
    await startOpsHost({
      taskId: flags.taskId ?? "",
      worktree: flags.worktree,
      targetPane: flags.targetPane ?? null,
      vendor: coerceVendorId(flags.vendor),
    })
    return true
  }
  return false
}
