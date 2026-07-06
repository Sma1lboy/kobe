/**
 * Workspace terminal tabs (issue #16) — the PTY-world chattab. A strip of
 * engine-terminal tabs above the embedded Terminal pane; every tab runs
 * the task's SAME interactive engine command in its own PTY (registry key
 * `${taskId}::${tabId}`), so ctrl+t gives a parallel session in the same
 * worktree exactly like the tmux chattab did with windows.
 *
 * Chords reuse the canonical chattab binding ids (keybindings-chat.ts):
 * ctrl+t new · ctrl+w close (last tab refuses) · F2 rename · ctrl+]/[
 * cycle. They are reserved from PTY passthrough in keys-pure.ts — same
 * interception the tmux root key-table performed.
 *
 * Per-task tab state lives in a module-level map so switching tasks and
 * back preserves each task's tabs (their PTYs already survive via the
 * registry's acquire-reuse).
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { RenameTaskDialog } from "../component/rename-task-dialog/index"
import { bindByIds } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { Terminal } from "../panes/terminal/Terminal"
import { useDialog } from "../ui/dialog"
import {
  type TabsState,
  type TerminalTab,
  addTab,
  closeActiveTab,
  cycleTab,
  initialTabs,
  renameActiveTab,
  tabPtyKey,
} from "./terminal-tabs-core"

/** Per-task tab state, preserved across task switches for the process. */
const tabsByTask = new Map<string, TabsState>()

function tabTitle(tab: TerminalTab): string {
  return tab.title ?? t("terminal.tab.defaultTitle", { n: tab.ordinal })
}

export function TerminalTabs(props: {
  taskId: string
  worktree: string
  command: readonly string[]
  focused: () => boolean
}): ReturnType<typeof Terminal> {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [state, setState] = createSignal<TabsState>(tabsByTask.get(props.taskId) ?? initialTabs())
  const update = (next: TabsState): void => {
    tabsByTask.set(props.taskId, next)
    setState(next)
  }

  const active = () => state().tabs.find((tab) => tab.id === state().activeId) ?? state().tabs[0]

  const requestRename = (): void => {
    const tab = active()
    if (!tab) return
    void RenameTaskDialog.show(dialog, tabTitle(tab), {
      dialogTitle: t("terminal.tab.renameTitle"),
      fieldLabel: t("terminal.tab.renameField"),
      submitLabel: t("terminal.tab.renameSubmit"),
      allowEmpty: true,
    }).then((title) => {
      if (title === undefined) return
      update(renameActiveTab(state(), title))
    })
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "chat.tab.new": () => update(addTab(state())),
      "chat.tab.close": () => {
        const { state: next } = closeActiveTab(state())
        update(next)
      },
      "chat.tab.rename": requestRename,
      "chat.tab.cycle-next": () => update(cycleTab(state(), 1)),
      "chat.tab.cycle-prev": () => update(cycleTab(state(), -1)),
    }),
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Tab strip — flush to the pane edge, dense, hidden for one tab. */}
      <Show when={state().tabs.length > 1}>
        <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.backgroundElement}>
          <For each={state().tabs}>
            {(tab) => (
              <text
                fg={tab.id === state().activeId ? theme.focusAccent : theme.textMuted}
                attributes={tab.id === state().activeId ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {tabTitle(tab)}
              </text>
            )}
          </For>
        </box>
      </Show>
      {/* keyed remount per tab — each tab owns a registry-backed PTY that
          survives switches; only the visible one renders. */}
      <Show when={active()} keyed>
        {(tab) => (
          <Terminal
            cwd={() => props.worktree}
            taskId={() => tabPtyKey(props.taskId, tab.id)}
            command={props.command}
            focused={props.focused}
          />
        )}
      </Show>
    </box>
  )
}
