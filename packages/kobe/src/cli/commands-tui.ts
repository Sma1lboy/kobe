import { ALL_VENDORS, type VendorId, coerceVendorId } from "../types/vendor.ts"

interface OpsFlags {
  taskId?: string
  worktree?: string
  targetPane?: string
  vendor?: string
  preview?: string
  session?: string
  repo?: string
  initialTaskId?: string
  action?: string
  windowId?: string
  cols?: string
  rows?: string
  status?: string
  client?: string
  title?: string
}

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

export async function dispatchTuiCommand(subcommand: string | undefined, rest: readonly string[]): Promise<boolean> {
  if (subcommand === "new-chattab") {
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe new-chattab: --session <name> is required")
      process.exit(2)
    }
    const { windowIsSurface } = await import("../tmux/client.ts")
    if (await windowIsSurface(session)) return true
    let vendor: VendorId | undefined
    if (flags.vendor !== undefined) {
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
    }
    const { newChatTab } = await import("../tui/panes/terminal/tmux.ts")
    await newChatTab(session, vendor)
    return true
  }
  if (subcommand === "engine-tab-exit") {
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
    const { runTmux, termAllPaneGroups, KOBE_TMUX_SOCKET } = await import("../tmux/client.ts")
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
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe focus-tasks: --session <name> is required")
      process.exit(2)
    }
    const { windowIsSurface } = await import("../tmux/client.ts")
    if (flags.windowId && (await windowIsSurface(flags.windowId))) return true
    const { selectTasksPane } = await import("../tui/panes/terminal/tmux.ts")
    await selectTasksPane(session, { windowId: flags.windowId })
    return true
  }
  if (subcommand === "heal-layout") {
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
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe capture-layout: --session <name> is required")
      process.exit(2)
    }
    const { captureGlobalLayoutOnDrag } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork, genAgeMs, RESIZE_GUARD_MS } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "capture", async () => {
      if (genAgeMs(session, "resize") < RESIZE_GUARD_MS) return
      await captureGlobalLayoutOnDrag(session)
    })
    return true
  }
  if (subcommand === "layout") {
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
  if (subcommand === "quick-task") {
    const flags = parseOpsFlags(rest)
    const { startQuickTaskHost } = await import("../tui/quick-task/host.tsx")
    await startQuickTaskHost({ session: flags.session })
    return true
  }
  if (subcommand === "tasks") {
    const flags = parseOpsFlags(rest)
    const { startTasksPane } = await import("../tui/tasks-pane/host.tsx")
    await startTasksPane({ initialTaskId: flags.initialTaskId })
    return true
  }
  if (subcommand === "settings") {
    const { startSettingsHost } =
      process.env.KOBE_REACT === "1"
        ? await import("../tui-react/settings/host.tsx")
        : await import("../tui/settings/host.tsx")
    await startSettingsHost()
    return true
  }
  if (subcommand === "worktrees") {
    const { startWorktreesHost } = await import("../tui/worktrees/host.tsx")
    await startWorktreesHost()
    return true
  }
  if (subcommand === "help-page") {
    const { startHelpHost } =
      process.env.KOBE_REACT === "1" ? await import("../tui-react/help/host.tsx") : await import("../tui/help/host.tsx")
    await startHelpHost()
    return true
  }
  if (subcommand === "new-task") {
    const flags = parseOpsFlags(rest)
    const { startNewTaskHost } = await import("../tui/new-task/host.tsx")
    await startNewTaskHost({ defaultRepo: flags.repo })
    return true
  }
  if (subcommand === "update-page") {
    const { startUpdateHost } = await import("../tui/update/host.tsx")
    await startUpdateHost()
    return true
  }
  if (subcommand === "history") {
    const flags = parseOpsFlags(rest)
    if (!flags.worktree) {
      console.error("kobe history: --worktree <path> is required")
      process.exit(2)
    }
    const { startHistoryHost } =
      process.env.KOBE_REACT === "1"
        ? await import("../tui-react/history/host.tsx")
        : await import("../tui/history/host.tsx")
    await startHistoryHost({
      worktree: flags.worktree,
      vendor: coerceVendorId(flags.vendor),
      title: flags.title,
      live: rest.includes("--live"),
    })
    return true
  }
  if (subcommand === "ops") {
    const flags = parseOpsFlags(rest)
    if (!flags.worktree) {
      console.error("kobe ops: --worktree <path> is required")
      process.exit(2)
    }
    if (flags.preview) {
      const { startOpsPreview } =
        process.env.KOBE_REACT === "1"
          ? await import("../tui-react/ops/preview.tsx")
          : await import("../tui/ops/preview.tsx")
      await startOpsPreview({ worktree: flags.worktree, relPath: flags.preview })
      return true
    }
    const { startOpsHost } =
      process.env.KOBE_REACT === "1" ? await import("../tui-react/ops/host.tsx") : await import("../tui/ops/host.tsx")
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
