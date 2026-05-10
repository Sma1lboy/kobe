/**
 * Workspace center-column tab strategy — chat tabs (multitab) plus AT
 * MOST ONE file tab per task (KOB-20). Owns:
 *
 *   - Persisted `tabsByTask` (active chat | active file).
 *   - Memoised accessors (`currentTabs`, `activeCenterTab`,
 *     `isChatTabActive`, `activeFileTabPath`, `activeChatTabsAcc`,
 *     `activeChatTabIdAcc`).
 *   - Mutators: `openFileInCenter`, `selectChatTab`, `selectChatTabById`,
 *     `selectFileTab`, `closeFileTab`.
 *
 * Per the resolved Wave-1 invariant ("each sidebar session = one
 * worktree") and Jackson's call (KOB-20): the workspace shows a chat
 * tab plus AT MOST ONE file tab. Each click in the file tree replaces
 * whatever file was previously open — the chip swaps its label and the
 * preview re-renders. No accumulation of file chips. Switching tasks
 * restores the active tab exactly.
 *
 * Extracted from `Shell` in `app.tsx`. Must be invoked inside a Solid
 * component scope (it allocates signals + memos + an effect).
 */

import { type Accessor, createEffect, createMemo, createSignal } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator.ts"
import type { ChatTab, Task } from "../../types/task.ts"
import type { PaneId } from "../context/focus"
import type { KVContext } from "../context/kv"
import type { PreviewApi } from "../panes/preview"

/** Discriminated union for the active center tab: a literal `"chat"` or a file. */
export type CenterTab = "chat" | { kind: "file"; path: string }
export type TaskCenterTabs = { active: CenterTab }

const EMPTY_TABS: TaskCenterTabs = { active: "chat" }

export type WorkspaceTabsDeps = {
  orchestrator: KobeOrchestrator
  kv: KVContext
  /** Currently-selected task id (or null when nothing is selected). */
  selectedId: Accessor<string | null>
  /** Active Task record — reactive; used to read its multi-tab list. */
  activeTask: Accessor<Task | undefined>
  /** Preview's imperative API (set by the Preview pane on mount). */
  previewApi: Accessor<PreviewApi | null>
  /** Focus setter — `selectChatTab*` and `selectFileTab` pull focus to workspace. */
  setFocusedPane: (id: PaneId) => void
}

export type WorkspaceTabs = {
  currentTabs: Accessor<TaskCenterTabs>
  activeCenterTab: Accessor<CenterTab>
  isChatTabActive: Accessor<boolean>
  activeFileTabPath: Accessor<string | null>
  activeChatTabsAcc: Accessor<readonly ChatTab[]>
  activeChatTabIdAcc: Accessor<string | null>
  openFileInCenter: (relPath: string) => void
  selectChatTab: () => void
  selectChatTabById: (tabId: string) => void
  selectFileTab: (relPath: string) => void
  closeFileTab: (relPath: string) => void
}

export function useWorkspaceTabs(deps: WorkspaceTabsDeps): WorkspaceTabs {
  const { orchestrator, kv, selectedId, activeTask, previewApi, setFocusedPane } = deps

  // Hydrate from KV. Stored as a plain object keyed by taskId because Maps
  // aren't JSON-serializable. Tasks deleted between runs leak entries into
  // the file; harmless and pruned the next time we persist after a real
  // selection change. (Could prune on hydrate if it ever matters.)
  // Backwards-compat: pre-KOB-20 entries had a `string[]` under `open`;
  // we drop the field on hydrate. `active` survives the migration verbatim
  // — if it pointed at a file path, the new state still opens that file.
  const persistedTabs = kv.get("centerTabsByTask") as Record<string, { active?: CenterTab; open?: unknown }> | undefined
  const [tabsByTask, setTabsByTask] = createSignal(
    new Map<string, TaskCenterTabs>(
      persistedTabs
        ? Object.entries(persistedTabs).map(([id, raw]) => [id, { active: raw?.active ?? "chat" }] as const)
        : [],
    ),
  )

  const currentTabs = createMemo<TaskCenterTabs>(() => {
    const id = selectedId()
    if (!id) return EMPTY_TABS
    return tabsByTask().get(id) ?? EMPTY_TABS
  })
  const activeCenterTab = createMemo<CenterTab>(() => currentTabs().active)
  const isChatTabActive = createMemo<boolean>(() => activeCenterTab() === "chat")
  const activeFileTabPath = createMemo<string | null>(() => {
    const a = activeCenterTab()
    return typeof a === "object" ? a.path : null
  })

  function mutateTabs(taskId: string, updater: (cur: TaskCenterTabs) => TaskCenterTabs): void {
    setTabsByTask((prev) => {
      const next = new Map(prev)
      const cur = next.get(taskId) ?? EMPTY_TABS
      next.set(taskId, updater(cur))
      return next
    })
  }

  /** Helper: tell Preview to drop whichever file (if any) is currently
   *  open, so its internal tab list stays at most one entry. */
  function dropPreviousFileFromPreview(cur: TaskCenterTabs, except?: string): void {
    if (typeof cur.active === "object" && cur.active.kind === "file" && cur.active.path !== except) {
      previewApi()?.close(cur.active.path)
    }
  }

  function openFileInCenter(relPath: string): void {
    const id = selectedId()
    if (!id) return
    dropPreviousFileFromPreview(currentTabs(), relPath)
    mutateTabs(id, () => ({ active: { kind: "file", path: relPath } }))
    previewApi()?.open(relPath)
    // Focus stays on whichever pane the user was in (typically FILES,
    // since that's where the click/enter happened). Jackson explicitly
    // does NOT want this to pull focus to the workspace — the open is
    // a content swap in the centre, not a navigation.
  }

  function selectChatTab(): void {
    const id = selectedId()
    if (!id) return
    dropPreviousFileFromPreview(currentTabs())
    mutateTabs(id, () => ({ active: "chat" }))
    setFocusedPane("workspace")
  }

  // Chat tabs (multitab) — pulled off the active task so the
  // CenterTabStrip can render one chip per chat tab alongside the
  // (single) file chip. activeChatTabIdAcc tracks which chat tab the
  // orchestrator currently considers active; click-to-switch on a
  // chip flows through `selectChatTabById` which in turn calls
  // orchestrator.setActiveTab + flips the workspace tab to chat.
  const activeChatTabsAcc = createMemo<readonly ChatTab[]>(() => activeTask()?.tabs ?? [])
  const activeChatTabIdAcc = createMemo<string | null>(() => activeTask()?.activeTabId ?? null)
  function selectChatTabById(tabId: string): void {
    const id = selectedId()
    if (!id) return
    void orchestrator.setActiveTab(id, tabId).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[kobe] setActiveTab failed:", err)
    })
    dropPreviousFileFromPreview(currentTabs())
    mutateTabs(id, () => ({ active: "chat" }))
    setFocusedPane("workspace")
  }

  function selectFileTab(relPath: string): void {
    // Single file tab: clicking it just keeps it active. The previous
    // file (if any other path) was already dropped when this one was
    // opened — we don't need to drop it again here. Keep the function
    // for symmetry with the chat-tab handlers + future re-entry.
    const id = selectedId()
    if (!id) return
    mutateTabs(id, () => ({ active: { kind: "file", path: relPath } }))
    previewApi()?.open(relPath)
    setFocusedPane("workspace")
  }

  function closeFileTab(relPath: string): void {
    const id = selectedId()
    if (!id) return
    dropPreviousFileFromPreview(currentTabs(), undefined)
    mutateTabs(id, () => ({ active: "chat" }))
    void relPath
  }

  // Persist per-task tab state whenever it changes. The KV store
  // debounces writes internally so this is cheap.
  createEffect(() => {
    const obj: Record<string, TaskCenterTabs> = {}
    for (const [id, tabs] of tabsByTask()) obj[id] = tabs
    kv.set("centerTabsByTask", obj)
  })

  return {
    currentTabs,
    activeCenterTab,
    isChatTabActive,
    activeFileTabPath,
    activeChatTabsAcc,
    activeChatTabIdAcc,
    openFileInCenter,
    selectChatTab,
    selectChatTabById,
    selectFileTab,
    closeFileTab,
  }
}
