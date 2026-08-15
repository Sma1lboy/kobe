/**
 * `rove api pane-open` — open a terminal pane in a task's workspace over the
 * daemon's `tab.open` channel (the same wire `rove plugin pane open` rides).
 * The attached TUI hosting the task performs the actual split/tab; the
 * daemon only validates + broadcasts. Herdr-style `pane split` for agents:
 * split the focused tab right/down running any command, or open a separate
 * command tab.
 */

import { F } from "./flags.ts"
import { daemonOf, simpleRpc } from "./handler-helpers.ts"
import { resolveActiveTaskId } from "./runtime.ts"
import { ApiError, type VerbSpec } from "./types.ts"

export const PANE_VERB: VerbSpec = {
  name: "pane-open",
  summary:
    "Open a terminal pane in a task's workspace: split the focused tab (default) or open a separate command tab, optionally running a command. Broadcast over the daemon's tab.open channel — an attached TUI showing the task performs the split. Task defaults to $ROVE_TASK_ID, then the active task.",
  flags: [
    F.taskId(false),
    {
      name: "command",
      type: "string",
      placeholder: "CMD",
      description:
        "Shell command the pane runs (via `sh -lc`, so pipes/args work); the pane closes when it exits. Omit for an interactive shell.",
    },
    {
      name: "direction",
      type: "enum",
      values: ["right", "down"],
      default: "right",
      description: "Split orientation relative to the active pane (split placement only).",
    },
    {
      name: "placement",
      type: "enum",
      values: ["split", "tab"],
      default: "split",
      description: "`split` joins the focused tab's split group; `tab` opens a separate command tab.",
    },
    {
      name: "title",
      type: "string",
      placeholder: "TEXT",
      description: 'Pane label (default: the command\'s first word, else "shell").',
    },
  ],
  handler: async (ctx) => {
    const client = daemonOf(ctx)
    // The CLI boundary mirrors ROVE_* onto KOBE_* before any subsystem
    // starts (`rename-compat.ts`), so this legacy read resolves the canonical
    // $ROVE_TASK_ID the help text advertises as well as the alias.
    const taskId = ctx.args.str("task-id") ?? process.env.KOBE_TASK_ID ?? (await resolveActiveTaskId(client))
    if (!taskId) {
      throw new ApiError("no target task: pass --task-id (no $ROVE_TASK_ID, no active task)", "TASK_NOT_FOUND")
    }
    const command = ctx.args.str("command")
    const argv = command ? ["sh", "-lc", command] : [process.env.SHELL || "sh"]
    const title = ctx.args.str("title") ?? (command ? (command.trim().split(/\s+/)[0] ?? "shell") : "shell")
    return simpleRpc(ctx, "tab.open", {
      taskId,
      argv,
      title,
      placement: ctx.args.str("placement") ?? "split",
      direction: ctx.args.str("direction") ?? "right",
    })
  },
}

export const PANE_CLOSE_VERB: VerbSpec = {
  name: "pane-close",
  summary:
    "Close panes opened by pane-open: every split pane / command tab in the task whose label matches --title. Broadcast over the daemon's tab.close channel — an attached TUI showing the task performs the close (headless no-op). Task defaults to $ROVE_TASK_ID, then the active task.",
  flags: [
    F.taskId(false),
    {
      name: "title",
      type: "string",
      required: true,
      placeholder: "TEXT",
      description: "Pane label to close — the --title the pane was opened with (engine panes are never closed).",
    },
  ],
  handler: async (ctx) => {
    const client = daemonOf(ctx)
    const taskId = ctx.args.str("task-id") ?? process.env.KOBE_TASK_ID ?? (await resolveActiveTaskId(client))
    if (!taskId) {
      throw new ApiError("no target task: pass --task-id (no $ROVE_TASK_ID, no active task)", "TASK_NOT_FOUND")
    }
    return simpleRpc(ctx, "tab.close", { taskId, title: ctx.args.str("title") })
  },
}
