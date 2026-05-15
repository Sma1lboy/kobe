import type { Accessor, Setter } from "solid-js"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import type { ChatTab } from "../../../types/task"
import { ResumeDialog } from "../../component/resume-dialog"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"
import type { useDialog } from "../../ui/dialog"
import { stringifyErr } from "./chat-utils"
import type { ChatState } from "./row-types"
import { pushSystemError } from "./store"

type PatchState = (fn: (state: ChatState) => ChatState) => void

export function useChatTabs(opts: {
  readonly orchestrator: KobeOrchestrator
  readonly dialog: ReturnType<typeof useDialog>
  readonly taskId: Accessor<string | undefined>
  readonly focused?: Accessor<boolean>
  readonly tabs: Accessor<readonly ChatTab[]>
  readonly activeTabId: Accessor<string | null>
  readonly setActiveTabIdLocal: (id: string | null) => void
  readonly setExpandedToolIndex: Setter<number | null>
  readonly setExpandedFoldStartIndex: Setter<number | null>
  readonly patchActiveState: PatchState
  readonly abortBashForTab: (tabId: string) => void
  readonly onRenameTabRequest?: (tabId: string) => void
  readonly onQuickForkRequest?: () => void
}) {
  function resetExpansion(): void {
    opts.setExpandedToolIndex(null)
    opts.setExpandedFoldStartIndex(null)
  }

  async function newTab(): Promise<void> {
    const taskId = opts.taskId()
    if (!taskId) return
    try {
      const tab = await opts.orchestrator.createTab(taskId)
      opts.setActiveTabIdLocal(tab.id)
      resetExpansion()
      void opts.orchestrator.setActiveTab(taskId, tab.id)
    } catch (err) {
      opts.patchActiveState((s) => pushSystemError(s, `createTab failed: ${stringifyErr(err)}`))
    }
  }

  async function closeActiveTab(): Promise<void> {
    const taskId = opts.taskId()
    const tabId = opts.activeTabId()
    if (!taskId || !tabId) return
    if (opts.tabs().length <= 1) return
    opts.abortBashForTab(tabId)
    try {
      const nextActive = await opts.orchestrator.closeTab(taskId, tabId)
      if (nextActive) {
        opts.setActiveTabIdLocal(nextActive)
        resetExpansion()
      }
    } catch (err) {
      opts.patchActiveState((s) => pushSystemError(s, `closeTab failed: ${stringifyErr(err)}`))
    }
  }

  function selectTabByIndex(idx: number): void {
    const tab = opts.tabs()[idx]
    if (!tab) return
    opts.setActiveTabIdLocal(tab.id)
    resetExpansion()
    const taskId = opts.taskId()
    if (taskId) void opts.orchestrator.setActiveTab(taskId, tab.id)
  }

  function cycleTab(delta: 1 | -1): void {
    const list = opts.tabs()
    if (list.length <= 1) return
    const cur = opts.activeTabId()
    const idx = cur ? list.findIndex((t) => t.id === cur) : 0
    selectTabByIndex((idx + delta + list.length) % list.length)
  }

  useBindings(() => ({
    enabled: opts.focused?.() === true,
    bindings: bindByIds({
      "chat.tab.new": () => void newTab(),
      "chat.tab.close": () => void closeActiveTab(),
      "chat.tab.cycle-next": () => cycleTab(1),
      "chat.tab.cycle-prev": () => cycleTab(-1),
      "chat.tab.rename": () => {
        const id = opts.activeTabId()
        if (id) opts.onRenameTabRequest?.(id)
      },
      "chat.session.resume": () => {
        const taskId = opts.taskId()
        if (!taskId) return
        ResumeDialog.show(opts.dialog, opts.orchestrator, taskId)
      },
      "chat.fork.new": () => {
        opts.onQuickForkRequest?.()
      },
    }),
  }))

  return { newTab, closeActiveTab, selectTabByIndex, cycleTab }
}
