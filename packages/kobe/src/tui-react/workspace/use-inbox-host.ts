import { useEffect, useMemo } from "react"
import type { AttentionInboxItem, RemoteOrchestrator } from "../../client/remote-orchestrator"
import type { Task } from "../../types/task"
import type { KVContext } from "../context/kv"
import { useLatest } from "../lib/use-latest"
import type { DialogContext } from "../ui/dialog"
import { AttentionInboxDialog } from "./AttentionInboxPane"
import {
  attentionInboxCounts,
  isAttentionInboxItemAvailable,
  partitionAttentionInboxAvailability,
  visitResolvedEpisodes,
} from "./attention-inbox-core"
import { requestInboxItemOpen } from "./inbox-open-action"
import { notifyInboxRpcFailure } from "./inbox-rpc-errors"
import { activeTabIdFor, knownTaskTab, requestTabActivation } from "./terminal-tabs-shared"

export function useInboxHost(args: {
  orchestrator: RemoteOrchestrator
  items: readonly AttentionInboxItem[]
  tasks: readonly Task[]
  kv: KVContext
  dialog: DialogContext
  selectedId: string | null
  selectTask: (taskId: string) => void
  focusWorkspace: () => void
  notifyError: (message: string) => void
}) {
  const { orchestrator: orch } = args
  const { availableItems, unavailableItems } = useMemo(
    () =>
      partitionAttentionInboxAvailability(
        args.items,
        args.tasks,
        (taskId, tabId) => knownTaskTab(args.kv, taskId, tabId) !== undefined,
      ),
    [args.items, args.tasks, args.kv],
  )
  const counts = attentionInboxCounts(availableItems)
  const notifyErrorRef = useLatest(args.notifyError)

  // The host is always mounted, unlike the Inbox dialog. Hide unavailable
  // targets from its count immediately, then remove their durable records in
  // the background so opening the dialog is never required for cleanup.
  useEffect(() => {
    for (const item of unavailableItems) {
      notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", notifyErrorRef.current)
    }
  }, [unavailableItems, orch])

  function openItem(item: AttentionInboxItem, knownAvailable?: boolean): void {
    const task = orch.getTask(item.taskId)
    const available =
      knownAvailable ??
      isAttentionInboxItemAvailable(item, task, (tabId) => knownTaskTab(args.kv, item.taskId, tabId) !== undefined)
    if (!requestInboxItemOpen(item, available, orch, args.notifyError)) return
    if (args.dialog.stack.length > 0) args.dialog.clear({ refocus: false })
    args.selectTask(item.taskId)
    if (item.tabId) requestTabActivation(item.taskId, item.tabId)
    args.focusWorkspace()
  }

  function show(): void {
    AttentionInboxDialog.show(args.dialog, {
      orchestrator: orch,
      onOpen: openItem,
      onDelete: (item) =>
        notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", args.notifyError),
    })
  }

  const availableItemsRef = useLatest(availableItems)
  function resolveVisited(taskId: string, tabId: string): void {
    for (const item of visitResolvedEpisodes(availableItemsRef.current, { taskId, tabId })) {
      notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", notifyErrorRef.current)
    }
  }

  // Resolve episodes that arrive while their target is already visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the queue push only; selection/tab reads use the current render.
  useEffect(() => {
    if (!args.selectedId) return
    const activeTab = activeTabIdFor(args.selectedId)
    if (activeTab) resolveVisited(args.selectedId, activeTab)
  }, [availableItems])

  return { availableItems, counts, openItem, show, resolveVisited }
}
