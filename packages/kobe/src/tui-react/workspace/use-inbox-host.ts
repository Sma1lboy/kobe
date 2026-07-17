import { useEffect, useMemo, useRef } from "react"
import type { AttentionInboxItem, RemoteOrchestrator } from "../../client/remote-orchestrator"
import type { Task } from "../../types/task"
import type { KVContext } from "../context/kv"
import { useLatest } from "../lib/use-latest"
import type { DialogContext } from "../ui/dialog"
import { AttentionInboxDialog } from "./AttentionInboxPane"
import {
  attentionInboxCounts,
  attentionInboxKey,
  isAttentionInboxItemAvailable,
  partitionAttentionInboxAvailability,
  visitResolvedEpisodes,
} from "./attention-inbox-core"
import { requestInboxItemOpen } from "./inbox-open-action"
import { notifyInboxRpcFailure } from "./inbox-rpc-errors"
import { activeTabIdFor, knownTaskTab, requestTabActivation } from "./terminal-tabs-shared"

function episodeKey(item: AttentionInboxItem): string {
  return `${attentionInboxKey(item)}\0${item.at}`
}

function episodeSignature(items: readonly AttentionInboxItem[]): string {
  return items.map(episodeKey).sort().join("\n")
}

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
  const unavailableItemsRef = useLatest(unavailableItems)
  const unavailableSignature = episodeSignature(unavailableItems)
  const attemptedUnavailable = useRef(new Set<string>())

  // The host is always mounted, unlike the Inbox dialog. Hide unavailable
  // targets from its count immediately, then remove their durable records in
  // the background so opening the dialog is never required for cleanup. Each
  // episode is attempted once while unavailable: unrelated KV writes rebuild
  // the partition but must not repeat the RPC or its failure toast.
  useEffect(() => {
    const currentItems = unavailableItemsRef.current
    if (episodeSignature(currentItems) !== unavailableSignature) return
    const currentKeys = new Set(currentItems.map(episodeKey))
    for (const attempted of attemptedUnavailable.current) {
      if (!currentKeys.has(attempted)) attemptedUnavailable.current.delete(attempted)
    }
    for (const item of currentItems) {
      const key = episodeKey(item)
      if (attemptedUnavailable.current.has(key)) continue
      attemptedUnavailable.current.add(key)
      notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", notifyErrorRef.current)
    }
  }, [unavailableSignature, orch])

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
  const availableSignature = episodeSignature(availableItems)
  const selectedIdRef = useLatest(args.selectedId)
  function resolveVisited(taskId: string, tabId: string): void {
    for (const item of visitResolvedEpisodes(availableItemsRef.current, { taskId, tabId })) {
      notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", notifyErrorRef.current)
    }
  }

  // Resolve episodes that arrive while their target is already visible. The
  // stable signature changes for queue episodes or availability, not for an
  // unrelated KV context rebuild; selection/tab reads use the current render.
  useEffect(() => {
    const currentItems = availableItemsRef.current
    if (episodeSignature(currentItems) !== availableSignature) return
    const selectedId = selectedIdRef.current
    if (!selectedId) return
    const activeTab = activeTabIdFor(selectedId)
    if (!activeTab) return
    for (const item of visitResolvedEpisodes(currentItems, { taskId: selectedId, tabId: activeTab })) {
      notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", notifyErrorRef.current)
    }
  }, [availableSignature, orch])

  return { availableItems, counts, openItem, show, resolveVisited }
}
