/**
 * WorkspaceTabs — the center workspace for the selected task. Tabs can be an
 * empty chooser, a vendor engine PTY, a plain terminal PTY, or a file preview.
 * The list is client-owned (persisted in localStorage). Selecting a task with
 * no tabs opens an empty chooser tab automatically.
 */

import { Bot, Terminal } from "lucide-react"
import type { DragEvent, ReactNode } from "react"
import { useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import {
  addEmptyTab,
  clearSplitTab,
  closeTab,
  configureTab,
  setActiveTab,
  setSplitTab,
  useTabsState,
  type WorkspaceTab,
} from "../lib/tabs.ts"
import { closePtyTab } from "../lib/terminal.ts"
import { ChatTerminal } from "./ChatTerminal.tsx"
import { FilePreview } from "./DiffView.tsx"

const VENDORS = ["claude", "codex", "copilot"] as const

function vendorLabel(vendor: string | undefined): string {
  return vendor ?? "claude"
}

function EmptyTabChooser({
  taskId,
  tabId,
  vendor,
}: {
  taskId: string
  tabId: string
  vendor: string
}) {
  const cards = [
    {
      title: "Vendor",
      detail: vendor,
      body: "Start an engine session for this task.",
      icon: Bot,
      action: () => configureTab(taskId, tabId, "vendor"),
    },
    {
      title: "Terminal",
      detail: "shell / worktree",
      body: "Open a command shell in this task worktree.",
      icon: Terminal,
      action: () => configureTab(taskId, tabId, "terminal"),
    },
  ]

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="grid w-full max-w-xl grid-cols-1 gap-3 md:grid-cols-2">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <button
              key={card.title}
              type="button"
              onClick={card.action}
              className="group flex min-h-36 flex-col border border-line bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-inset"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-line bg-bg text-muted group-hover:border-primary group-hover:text-primary">
                  <Icon size={17} strokeWidth={1.8} />
                </span>
                <span className="truncate text-[10px] uppercase text-subtle">
                  {card.detail}
                </span>
              </div>
              <div className="mt-5 text-[12px] font-bold uppercase tracking-[0.12em] text-fg">
                {card.title}
              </div>
              <div className="mt-2 text-[12px] leading-relaxed text-subtle">
                {card.body}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TabContent({
  tab,
  taskId,
  taskWorktreePath,
  vendor,
}: {
  tab: WorkspaceTab | undefined
  taskId: string
  taskWorktreePath: string | null
  vendor: string
}) {
  if (tab?.kind === "empty")
    return <EmptyTabChooser taskId={taskId} tabId={tab.id} vendor={vendor} />
  if (tab?.kind === "vendor")
    return (
      <ChatTerminal key={tab.id} tabId={tab.id} taskId={taskId} mode="engine" />
    )
  if (tab?.kind === "terminal")
    return (
      <ChatTerminal key={tab.id} tabId={tab.id} taskId={taskId} mode="shell" />
    )
  if (tab?.kind === "file")
    return <FilePreview worktreePath={taskWorktreePath} path={tab.path} />
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-subtle">
      Opening a tab…
    </div>
  )
}

function PaneFrame({
  tab,
  side,
  children,
  onCloseSplit,
}: {
  tab: WorkspaceTab | undefined
  side: "left" | "right"
  children: ReactNode
  onCloseSplit?: () => void
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {side === "right" && (
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
          <span className="truncate text-[11px] text-muted">
            {tab?.title ?? "Split"}
          </span>
          <button
            type="button"
            onClick={onCloseSplit}
            className="text-[11px] text-subtle hover:text-fg"
            aria-label="close split"
            title="Close split"
          >
            ×
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 p-2">{children}</div>
    </div>
  )
}

export function WorkspaceTabs() {
  const [vendorOpen, setVendorOpen] = useState(false)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [splitDropActive, setSplitDropActive] = useState(false)
  const { selectedTaskId, tabsByTask, activeByTask, splitByTask } =
    useTabsState()
  const { tasks } = useAppState()
  const task = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null
  const tabs = selectedTaskId ? (tabsByTask[selectedTaskId] ?? []) : []
  const active = selectedTaskId ? activeByTask[selectedTaskId] : undefined
  const split = selectedTaskId ? splitByTask[selectedTaskId] : undefined

  const onClose = (tabId: string): void => {
    if (!selectedTaskId) return
    const tab = tabs.find((t) => t.id === tabId)
    closeTab(selectedTaskId, tabId)
    if (tab?.kind === "vendor" || tab?.kind === "terminal")
      void closePtyTab(tabId)
  }

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0]
  const splitTab =
    split && split !== activeTab?.id
      ? tabs.find((t) => t.id === split)
      : undefined
  const vendor = vendorLabel(task?.vendor)
  const setVendor = (next: string): void => {
    if (!selectedTaskId) return
    setVendorOpen(false)
    void rpc("task.setVendor", { taskId: selectedTaskId, vendor: next }).catch(
      () => {},
    )
  }
  const onContentDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!selectedTaskId || !draggingTabId) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    setSplitDropActive(event.clientX > rect.left + rect.width / 2)
  }
  const onContentDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!selectedTaskId || !draggingTabId) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX > rect.left + rect.width / 2) {
      setSplitTab(selectedTaskId, draggingTabId)
    } else {
      setActiveTab(selectedTaskId, draggingTabId)
    }
    setDraggingTabId(null)
    setSplitDropActive(false)
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-surface">
        {!selectedTaskId ? (
          <div className="flex items-center gap-2 px-3 text-[11px] text-subtle">
            <span className="h-1.5 w-1.5 rounded-full bg-subtle" />
            No task selected
          </div>
        ) : (
          <>
            <div
              className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
              role="tablist"
            >
              {tabs.map((t) => {
                const isActive = t.id === activeTab?.id
                const isSplit = t.id === splitTab?.id
                return (
                  <div
                    key={t.id}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move"
                      event.dataTransfer.setData("text/plain", t.id)
                      setDraggingTabId(t.id)
                    }}
                    onDragEnd={() => {
                      setDraggingTabId(null)
                      setSplitDropActive(false)
                    }}
                    className={`group flex h-9 select-none items-center gap-2 border-r border-b-2 border-r-line px-3 text-[12px] transition-colors ${
                      isActive
                        ? "border-b-primary bg-bg text-fg"
                        : isSplit
                          ? "border-b-kobe-blue bg-inset text-fg"
                          : "border-b-transparent text-muted hover:bg-inset/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveTab(selectedTaskId, t.id)}
                      className="max-w-40 cursor-grab truncate active:cursor-grabbing"
                      title={isSplit ? `${t.title} (split)` : t.title}
                    >
                      {t.title}
                    </button>
                    {isSplit && (
                      <span className="text-[9px] font-bold uppercase text-kobe-blue">
                        Split
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onClose(t.id)}
                      className="text-subtle opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                      aria-label="close tab"
                      title="Close tab"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() => addEmptyTab(selectedTaskId)}
                className="px-3 text-[13px] text-subtle hover:text-fg"
                aria-label="new tab"
                title="New tab"
              >
                +
              </button>
            </div>
            <div className="relative flex shrink-0 items-center border-l border-line px-2">
              <button
                type="button"
                onClick={() => setVendorOpen((open) => !open)}
                className="rounded border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
                title="Select vendor / model"
              >
                {vendor}
              </button>
              {vendorOpen && (
                <div className="absolute right-2 top-8 z-10 w-40 border border-line bg-menu shadow-xl">
                  {VENDORS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVendor(v)}
                      className={`block w-full px-3 py-2 text-left text-[12px] hover:bg-inset ${
                        v === vendor ? "text-primary" : "text-muted"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <section
        className="relative min-h-0 flex-1"
        aria-label="Workspace"
        onDragOver={onContentDragOver}
        onDragLeave={() => setSplitDropActive(false)}
        onDrop={onContentDrop}
      >
        {selectedTaskId && activeTab ? (
          <div className="flex h-full min-w-0">
            <PaneFrame tab={activeTab} side="left">
              <TabContent
                tab={activeTab}
                taskId={selectedTaskId}
                taskWorktreePath={task?.worktreePath ?? null}
                vendor={vendor}
              />
            </PaneFrame>
            {splitTab && (
              <>
                <div className="w-px shrink-0 bg-line" />
                <PaneFrame
                  tab={splitTab}
                  side="right"
                  onCloseSplit={() => {
                    if (selectedTaskId) clearSplitTab(selectedTaskId)
                  }}
                >
                  <TabContent
                    tab={splitTab}
                    taskId={selectedTaskId}
                    taskWorktreePath={task?.worktreePath ?? null}
                    vendor={vendor}
                  />
                </PaneFrame>
              </>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <div className="font-mono text-[13px] font-bold text-primary">
                [kobe web]
              </div>
              <h1 className="mt-4 text-[18px] font-semibold text-fg">
                {task
                  ? "Opening workspace…"
                  : "Select a task to open its workspace."}
              </h1>
              <p className="mt-2 text-[12px] leading-relaxed text-subtle">
                Web workspaces keep their own browser tabs, split panes, notes,
                and file previews for each task.
              </p>
            </div>
          </div>
        )}
        {draggingTabId && (
          <div
            className={`pointer-events-none absolute inset-y-2 right-2 flex w-[calc(50%-0.5rem)] items-center justify-center border border-dashed ${
              splitDropActive
                ? "border-primary bg-primary/10"
                : "border-line bg-inset/40"
            }`}
          >
            <span className="border border-line bg-bg px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
              Drop to split right
            </span>
          </div>
        )}
      </section>
    </section>
  )
}
