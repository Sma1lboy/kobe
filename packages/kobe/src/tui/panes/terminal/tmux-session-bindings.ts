import { KOBE_TMUX_SOCKET, runTmuxSequence } from "@/tmux/client"
import { clipboardBinaryOnPath, clipboardTmuxConfig, resolveClipboardCopyCommand } from "@/tmux/clipboard"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_LEGACY_LAYOUT_ROOT_KEYS,
  TMUX_SINGLE_BINDING_DEFAULTS,
  chordToTmuxKey,
  isTmuxPrefixBindingId,
  resolveUserTmuxKeys,
} from "@/tmux/keybindings"
import { HIDDEN_TASKS_PANE_OPTION, openUrlCommand, shellQuote } from "@/tmux/session-layout"
import {
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  kobeStatusRight,
} from "./chattab"
import { inheritedEnvPrefix } from "./launch"

const FOCUS_EDGE_VARS = {
  "-L": "pane_at_left",
  "-D": "pane_at_bottom",
  "-U": "pane_at_top",
  "-R": "pane_at_right",
} as const

export type FocusDirection = keyof typeof FOCUS_EDGE_VARS

export function focusBindCommand(key: string, dir: FocusDirection, edgeCommand?: string): readonly string[] {
  const condition = `#{?window_zoomed_flag,1,#{?${FOCUS_EDGE_VARS[dir]},,1}}`
  if (edgeCommand) {
    return ["bind-key", "-n", key, "if-shell", "-F", condition, `select-pane ${dir}`, edgeCommand]
  }
  return ["bind-key", "-n", key, "if-shell", "-F", condition, `select-pane ${dir}`]
}

export function tasksRestoreEdgeCommand(restoreTasksCommand: string): string {
  return `if-shell -F '#{?#{==:#{@kobe_role},tasks},,1}' { run-shell -b ${shellQuote(restoreTasksCommand)} }`
}

export async function installSessionBindings(inv: readonly string[]): Promise<void> {
  const envStr = inheritedEnvPrefix()
  const invStr = inv.map(shellQuote).join(" ")
  const newChatTabCommand = `${envStr}${invStr} new-chattab --session '#{session_name}'`
  const chooseEngineCommand = `${newChatTabCommand} --vendor '%%'`
  const chooseEngineTmuxCommand = `run-shell ${shellQuote(chooseEngineCommand)}`
  const focusTasksCommand = `${envStr}${invStr} focus-tasks --session '#{session_name}' --window '#{window_id}'`
  const focusTasksTmuxCommand = `run-shell ${shellQuote(focusTasksCommand)}`
  const layoutCommand = (action: string): string =>
    `${envStr}${invStr} layout --session '#{session_name}' --window '#{window_id}' --action ${action}`
  const restoreTasksCommand = layoutCommand("tasks-restore")

  const closeChatTabCommand = layoutCommand("chat-tab-close")
  const closeChatTabTmuxCommand = `run-shell ${shellQuote(closeChatTabCommand)}`
  const healLayoutCommand = `${envStr}${invStr} heal-layout --session '#{session_name}'`
  const healLayoutTmuxCommand = `run-shell -b ${shellQuote(healLayoutCommand)}`
  const resyncWindowCommand = `${envStr}${invStr} resync-window --session '#{session_name}' --client '#{client_name}' --cols '#{client_width}' --rows '#{client_height}' --status '#{status}'`
  const resyncWindowTmuxCommand = `run-shell -b ${shellQuote(resyncWindowCommand)}`
  const captureLayoutCommand = `${envStr}${invStr} capture-layout --session '#{session_name}'`
  const captureLayoutTmuxCommand = `run-shell -b ${shellQuote(captureLayoutCommand)}`
  const openUrlTmuxCommand = openUrlCommand({ tmuxSocket: KOBE_TMUX_SOCKET })
  const clipboardCopyCommand = resolveClipboardCopyCommand(process.platform, clipboardBinaryOnPath)
  const clipboardBindings = clipboardTmuxConfig(clipboardCopyCommand)
  const userKeys = resolveUserTmuxKeys()
  const unbinds: (readonly string[])[] = TMUX_LEGACY_LAYOUT_ROOT_KEYS.map((key) => ["unbind-key", "-n", key])
  if (userKeys.overridden.has(TMUX_FOCUS_ID)) {
    for (const chord of TMUX_FOCUS_DEFAULTS) {
      const t = chordToTmuxKey(chord)
      if ("key" in t) unbinds.push(["unbind-key", "-n", t.key])
    }
  }
  for (const id of userKeys.overridden) {
    if (id === TMUX_FOCUS_ID) continue
    const def = TMUX_SINGLE_BINDING_DEFAULTS[id as keyof typeof TMUX_SINGLE_BINDING_DEFAULTS]
    const isPrefix = isTmuxPrefixBindingId(id)
    const t = chordToTmuxKey(def, { allowBare: isPrefix })
    if ("key" in t) unbinds.push(isPrefix ? ["unbind-key", t.key] : ["unbind-key", "-n", t.key])
  }
  const focusDirections: readonly FocusDirection[] = ["-L", "-D", "-U", "-R"]
  const focusBinds = userKeys.focus.flatMap((bind, i) => {
    const dir = focusDirections[i]
    const edgeCommand = dir === "-L" ? tasksRestoreEdgeCommand(restoreTasksCommand) : undefined
    return bind && dir ? [focusBindCommand(bind.key, dir, edgeCommand)] : []
  })
  const b = userKeys.binds
  const layoutBind = (id: keyof typeof b, action: string): (readonly string[])[] => {
    const bind = b[id]
    return bind ? ([["bind-key", bind.key, "run-shell", layoutCommand(action)]] as const) : []
  }
  const layoutChordGroup = (...ids: (keyof typeof b)[]): string | null => {
    const chords = ids.map((id) => b[id]?.chord).filter((chord): chord is string => !!chord)
    return chords.length > 0 ? chords.join("/") : null
  }
  const TAB_SWITCH_SURFACE_GUARD = "#{?#{@kobe_surface},0,1}"
  await runTmuxSequence([
    ["set-option", "-g", "status", "on"],
    ["set-window-option", "-g", "aggressive-resize", "on"],
    ["set-option", "-g", "monitor-activity", "on"],
    ["set-option", "-g", "visual-activity", "off"],
    ["set-option", "-g", "window-status-format", CHAT_TAB_STATUS_FORMAT],
    ["set-option", "-g", "window-status-current-format", CHAT_TAB_STATUS_CURRENT_FORMAT],
    [
      "set-option",
      "-g",
      "status-right",
      kobeStatusRight({
        focusLeft: userKeys.focus[0]?.key ?? null,
        detach: b["tmux.detach"]?.key ?? null,
        newTab: b["tmux.tab.new"]?.key ?? null,
        layoutSplits: layoutChordGroup(
          "tmux.layout.workspaceSplit",
          "tmux.layout.workspaceClose",
          "tmux.layout.workspaceReset",
        ),
        layoutPanes: layoutChordGroup(
          "tmux.layout.tasksToggle",
          "tmux.layout.opsToggle",
          "tmux.layout.terminalToggle",
          "tmux.layout.zenToggle",
        ),
      }),
    ],
    ["set-option", "-g", "mouse", "on"],
    ...clipboardBindings,
    ["set-hook", "-g", "window-resized", healLayoutTmuxCommand],
    ["set-hook", "-g", "client-resized", resyncWindowTmuxCommand],
    ["set-hook", "-g", "pane-exited", healLayoutTmuxCommand],
    ["set-hook", "-g", "window-layout-changed", captureLayoutTmuxCommand],
    ...unbinds,
    ...(b["tmux.detach"]
      ? [
          [
            "bind-key",
            "-n",
            b["tmux.detach"].key,
            "if-shell",
            "-F",
            `#{?#{${HIDDEN_TASKS_PANE_OPTION}},1,#{==:#{@kobe_role},tasks}}`,
            "detach-client",
            focusTasksTmuxCommand,
          ] as const,
        ]
      : []),
    ...focusBinds,
    ...(b["tmux.tab.new"] ? [["bind-key", "-n", b["tmux.tab.new"].key, "run-shell", newChatTabCommand] as const] : []),
    ...(b["tmux.tab.chooseEngine"]
      ? chatTabChooseEngineBindings(b["tmux.tab.chooseEngine"].key).map(
          (binding) => [...binding, chooseEngineTmuxCommand] as const,
        )
      : []),
    ...(b["tmux.tab.prev"] && b["tmux.tab.next"]
      ? chatTabSwitchBindings(b["tmux.tab.prev"].key, b["tmux.tab.next"].key)
      : b["tmux.tab.prev"]
        ? [
            [
              "bind-key",
              "-n",
              b["tmux.tab.prev"].key,
              "if-shell",
              "-F",
              TAB_SWITCH_SURFACE_GUARD,
              "previous-window",
            ] as const,
          ]
        : b["tmux.tab.next"]
          ? [
              [
                "bind-key",
                "-n",
                b["tmux.tab.next"].key,
                "if-shell",
                "-F",
                TAB_SWITCH_SURFACE_GUARD,
                "next-window",
              ] as const,
            ]
          : []),
    ...(b["tmux.tab.close"] ? [chatTabCloseBinding(b["tmux.tab.close"].key, closeChatTabTmuxCommand)] : []),
    ...(b["tmux.tab.rename"] ? [chatTabRenameBinding(b["tmux.tab.rename"].key)] : []),
    ...layoutBind("tmux.layout.workspaceSplit", "workspace-split"),
    ...layoutBind("tmux.layout.workspaceClose", "workspace-close"),
    ...layoutBind("tmux.layout.workspaceReset", "workspace-reset"),
    ...layoutBind("tmux.layout.tasksToggle", "tasks-toggle"),
    ...layoutBind("tmux.layout.opsToggle", "ops-toggle"),
    ...layoutBind("tmux.layout.terminalToggle", "terminal-toggle"),
    ...layoutBind("tmux.layout.zenToggle", "zen-toggle"),
    ["bind-key", "f", "run-shell", `${envStr}${invStr} quick-create --session '#{session_name}'`],
    ["bind-key", "u", "display-popup", "-E", openUrlTmuxCommand],
  ])
}
