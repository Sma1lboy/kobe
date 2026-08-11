import { useCallback, useEffect, useMemo, useRef } from "react"
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
import { writeInboxVisit } from "./inbox-visits"
import { activeTabIdFor, requestTabActivation, taskTabExists } from "./terminal-tabs-shared"

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
      // Tri-state (see taskTabExists): `undefined` when this task has no
      // readable tab list here, so an episode is never deleted just because
      // its task hasn't mounted in this process.
      partitionAttentionInboxAvailability(args.items, args.tasks, (taskId, tabId) =>
        taskTabExists(args.kv, taskId, tabId),
      ),
    [args.items, args.tasks, args.kv],
  )
  // Episodes whose target is what you're ALREADY looking at never surface:
  // the daemon records them unconditionally and its push lands before the
  // background dismiss (the resolve effect below) round-trips, so without
  // this synchronous filter the Inbox count flashes 1 → 0 on every
  // turn-complete of the current tab. The durable record is still cleaned
  // up by the dismiss — this only keeps it out of the visible queue.
  const viewingResolved = args.selectedId
    ? new Set(
        visitResolvedEpisodes(availableItems, {
          taskId: args.selectedId,
          tabId: activeTabIdFor(args.selectedId),
        }).map(episodeKey),
      )
    : null
  const visibleItems =
    viewingResolved && viewingResolved.size > 0
      ? availableItems.filter((item) => !viewingResolved.has(episodeKey(item)))
      : availableItems
  const counts = attentionInboxCounts(visibleItems)
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
      knownAvailable ?? isAttentionInboxItemAvailable(item, task, (tabId) => taskTabExists(args.kv, item.taskId, tabId))
    if (!requestInboxItemOpen(item, available, orch, args.notifyError)) return
    if (args.dialog.stack.length > 0) args.dialog.clear({ refocus: false })
    args.selectTask(item.taskId)
    if (item.tabId) requestTabActivation(item.taskId, item.tabId)
    args.focusWorkspace()
  }

  /** RECENT rows carry no episode — land on the task and its last tab. */
  function openTask(taskId: string, tabId: string | null): void {
    if (args.dialog.stack.length > 0) args.dialog.clear({ refocus: false })
    args.selectTask(taskId)
    if (tabId) requestTabActivation(taskId, tabId)
    args.focusWorkspace()
  }

  function show(): void {
    AttentionInboxDialog.show(args.dialog, {
      orchestrator: orch,
      selectedId: args.selectedId,
      onOpen: openItem,
      onOpenTask: openTask,
      onDelete: (item) =>
        notifyInboxRpcFailure(orch.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", args.notifyError),
    })
  }

  const availableItemsRef = useLatest(availableItems)
  const availableSignature = episodeSignature(availableItems)
  const selectedIdRef = useLatest(args.selectedId)
  const attemptedResolved = useRef(new Set<string>())
  const resolveEpisodes = useCallback(
    (items: readonly AttentionInboxItem[], visit: { taskId: string; tabId: string }) => {
      const currentKeys = new Set(items.map(episodeKey))
      for (const attempted of attemptedResolved.current) {
        if (!currentKeys.has(attempted)) attemptedResolved.current.delete(attempted)
      }
      for (const item of visitResolvedEpisodes(items, visit)) {
        const key = episodeKey(item)
        if (attemptedResolved.current.has(key)) continue
        attemptedResolved.current.add(key)
        notifyInboxRpcFailure(
          orch.dismissAttention(item.taskId, item.tabId, item.at),
          "dismiss",
          notifyErrorRef.current,
        )
      }
    },
    [orch],
  )

  /**
   * One landing = two records: the episode it resolves, and the visit that
   * feeds the Inbox's RECENT order. Recording HERE (rather than off task
   * selection) is what makes RECENT tab-accurate — you come back to the tab
   * you left, not to the task's default one.
   */
  function resolveVisited(taskId: string, tabId: string): void {
    resolveEpisodes(availableItemsRef.current, { taskId, tabId })
    writeInboxVisit(args.kv, { taskId, tabId, at: Date.now() })
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
    resolveEpisodes(currentItems, { taskId: selectedId, tabId: activeTab })
  }, [availableSignature, resolveEpisodes])

  return { availableItems: visibleItems, counts, openItem, show, resolveVisited }
}
