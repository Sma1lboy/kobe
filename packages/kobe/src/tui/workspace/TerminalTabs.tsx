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
import { defaultShell } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import {
  type TabsState,
  type TerminalTab,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  initialTabs,
  openEditorTab,
  renameActiveTab,
  tabPtyKey,
  tabToShell,
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
  /**
   * Hands the parent an imperative "open this file in a new editor tab"
   * function, called once on mount. Needed because tab state is private to
   * this component (module-scoped `tabsByTask` + a local signal) — the
   * FileTree pane's "open" action lives in `workspace/host.tsx`, a sibling,
   * not a descendant, so it can't reach `openEditorTab` any other way.
   * Re-fires on every remount (task/worktree switch — see the `keyed` Show
   * in `host.tsx`), rebinding to that mount's own tab state.
   */
  onEditorTabReady?: (open: (command: readonly string[], label: string) => void) => void
  focused: () => boolean
}): ReturnType<typeof Terminal> {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [state, setState] = createSignal<TabsState>(tabsByTask.get(props.taskId) ?? initialTabs())
  const update = (next: TabsState): void => {
    tabsByTask.set(props.taskId, next)
    setState(next)
  }

  props.onEditorTabReady?.((command, label) => update(openEditorTab(state(), command, label)))

  const active = () => state().tabs.find((tab) => tab.id === state().activeId) ?? state().tabs[0]

  /** Remount key for the active tab's Terminal: the id alone, until the tab
   *  degrades to a shell (`tabToShell`) — the `::sh` suffix then forces the
   *  keyed Show to remount so a fresh PTY is acquired with the new command.
   *  Born-with-command tabs (editor flow) never change key. */
  const renderKey = () => {
    const tab = active()
    return tab ? (tab.command && !tab.ephemeral ? `${tab.id}::sh` : tab.id) : undefined
  }

  /** Auto-close (issue #16): a tab running a one-off command (ephemeral
   *  editor tab, or an engine tab already degraded to a shell) closes
   *  itself when that process exits and releases its PTY — same cleanup
   *  `chat.tab.close` performs for a manual ctrl+w, just self-triggered.
   *  The last tab refuses to close (core guard) and keeps the exit
   *  banner + F5 recovery path instead. */
  function closeExitedTab(id: string): void {
    const { state: next, closedId } = closeTab(state(), id)
    if (closedId) getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
    update(next)
  }

  /** Vendor exit is an allowed case (owner decision 2026-07-06): an engine
   *  tab whose CLI exits degrades into a plain shell at the same worktree
   *  instead of freezing behind the dead-shell banner. State swaps first —
   *  the keyed remount detaches the old PTY's subscribers — then the dead
   *  PTY is released so the remount acquires a fresh shell. */
  function degradeToShell(id: string): void {
    const tab = state().tabs.find((t) => t.id === id)
    if (!tab || tab.command) return
    update(tabToShell(state(), id, [defaultShell()]))
    getDefaultPtyRegistry().release(tabPtyKey(props.taskId, id))
  }

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
        const { state: next, closedId } = closeActiveTab(state())
        update(next)
        // Kill the closed tab's PTY — nobody else owns this teardown
        // (releaseWhere only fires on task archive, releaseAll on app
        // exit), so dropping closedId here leaked the engine process
        // until archive — the exact ctrl+w leak class of issue #14.
        if (closedId) getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
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
          survives switches; only the visible one renders. Keyed on
          renderKey(), not the tab object: rename rebuilds the active tab
          object ({ ...t, title }), and object-keying made that remount
          the whole Terminal (teardown + re-measure + resize push against
          the live engine session) for a pure title change. The key only
          changes on tab switch or shell degradation (the one mutation
          that must respawn the PTY). */}
      <Show when={renderKey()} keyed>
        {(_key: string) => {
          const tab = active()
          const tabId = tab.id
          return (
            <Terminal
              cwd={() => props.worktree}
              taskId={() => tabPtyKey(props.taskId, tabId)}
              command={
                tab.command ?? (tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command)
              }
              onExit={tab.command ? () => closeExitedTab(tabId) : () => degradeToShell(tabId)}
              focused={props.focused}
            />
          )
        }}
      </Show>
    </box>
  )
}
