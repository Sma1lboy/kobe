/**
 * Workspace terminal tabs (issue #16) — the PTY-world chattab. A strip of
 * engine-terminal tabs above the embedded Terminal pane; every tab runs
 * an interactive engine command in its own PTY (registry key
 * `${taskId}::${tabId}`), so ctrl+t gives a parallel session in the same
 * worktree exactly like the tmux chattab did with windows. Plain ctrl+t
 * inherits the task's current engine; ctrl+e prompts for one instead
 * (`chat.tab.chooseEngine`, tmux's `ctrl+shift+t` equivalent) and pins it
 * to just that tab via `TerminalTab.vendor`.
 *
 * Chords reuse the canonical chattab binding ids (keybindings-chat.ts):
 * ctrl+t new · ctrl+e new-with-engine · ctrl+w close (last tab refuses) ·
 * F2 rename · ctrl+]/[ cycle. They are reserved from PTY passthrough in
 * keys-pure.ts — same interception the tmux root key-table performed.
 *
 * Per-task tab state lives in a module-level map so switching tasks and
 * back preserves each task's tabs (their PTYs already survive via the
 * registry's acquire-reuse).
 */

import { availableEngineIds } from "@/engine/account-detect"
import { interactiveEngineCommand } from "@/engine/interactive-command"
import type { VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { EnginePickerDialog } from "../component/engine-picker-dialog/index"
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
  /** Task's current engine + effort — used to build a per-tab command when
   *  a tab pins its own vendor via `chooseEngine`. */
  vendor: VendorId
  modelEffort?: string
  /** Best-effort: persist the picked vendor as the task's new default
   *  (mirrors tmux chattab's `rememberSessionVendor`). Omit to skip. */
  onChooseEngine?: (vendor: VendorId) => void
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

  const requestChooseEngine = (): void => {
    void (async () => {
      const available = await availableEngineIds()
      const picked = await EnginePickerDialog.show(dialog, available, props.vendor)
      if (picked === undefined) return
      update(addTab(state(), picked))
      props.onChooseEngine?.(picked)
    })()
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "chat.tab.new": () => update(addTab(state())),
      "chat.tab.chooseEngine": requestChooseEngine,
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
            command={tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command}
            focused={props.focused}
          />
        )}
      </Show>
    </box>
  )
}
