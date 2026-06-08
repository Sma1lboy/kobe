/**
 * ToolsPanel — the right rail. A segmented switch between the web-only Notes
 * scratchpad and a compact worktree CHANGES list.
 */

import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import {
  clearSelectedTask,
  openFilePreviewTab,
  useTabsState,
} from "../lib/tabs.ts"
import type { Task } from "../lib/types.ts"
import { ChangesList } from "./DiffView.tsx"
import { NotesPanel } from "./NotesPanel.tsx"

type Tool = "overview" | "notes" | "changes"

const STATUSES = [
  "backlog",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "error",
] as const

const VENDORS = ["claude", "codex", "copilot"] as const

function label(value: string): string {
  return value.replace(/_/g, " ")
}

function Field({
  name,
  value,
  mono = false,
}: {
  name: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0 border-b border-line-subtle py-2 last:border-b-0">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
        {name}
      </div>
      <div
        className={`mt-1 min-w-0 truncate text-[12px] text-fg ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value || "—"}
      </div>
    </div>
  )
}

function ActionButton({
  children,
  onClick,
  disabled,
  danger = false,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
        danger
          ? "border-kobe-red/40 text-kobe-red hover:bg-kobe-red/10"
          : "border-line bg-surface text-muted hover:border-primary hover:text-fg"
      }`}
    >
      {children}
    </button>
  )
}

function TaskOverview({ task }: { task: Task | null }) {
  const [title, setTitle] = useState(task?.title ?? "")
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setTitle(task?.title ?? "")
  }, [task?.title])

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <div>
          <div className="text-[12px] font-semibold text-fg">
            No task selected
          </div>
          <div className="mt-1 max-w-48 text-[12px] leading-relaxed text-subtle">
            Pick a task to edit its metadata and worktree state.
          </div>
        </div>
      </div>
    )
  }

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const rename = (): void => {
    const next = title.trim()
    if (!next || next === task.title) return
    void run("rename", () =>
      rpc("task.rename", { taskId: task.id, title: next }),
    )
  }

  const copyPath = (): void => {
    void navigator.clipboard
      ?.writeText(task.worktreePath)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }

  const archive = (): void => {
    if (!window.confirm(`Archive "${task.title || task.branch}"?`)) return
    void run("archive", async () => {
      await rpc("task.archive", { taskId: task.id, archived: true })
      clearSelectedTask()
      await rpc("task.setActive", { taskId: null })
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-3 py-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Task
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === "Enter") rename()
            }}
            className="min-w-0 flex-1 border border-line bg-bg px-2 py-1.5 text-[12px] text-fg focus:border-line-active focus:outline-none"
          />
          <ActionButton onClick={rename} disabled={busy === "rename"}>
            Save
          </ActionButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <Field name="Branch" value={task.branch} mono />
        <Field name="Vendor" value={task.vendor ?? "claude"} />
        <Field name="Worktree" value={task.worktreePath} mono />
        <Field name="Repo" value={task.repo} mono />

        <div className="mt-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
            Status
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() =>
                  void run(`status:${status}`, () =>
                    rpc("task.status", { taskId: task.id, status }),
                  )
                }
                disabled={busy !== null}
                className={`border px-2 py-1.5 text-left text-[11px] capitalize transition-colors disabled:opacity-40 ${
                  task.status === status
                    ? "border-primary bg-inset text-fg"
                    : "border-line bg-surface text-muted hover:border-primary hover:text-fg"
                }`}
              >
                {label(status)}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
            Vendor
          </div>
          <div className="flex flex-wrap gap-1.5">
            {VENDORS.map((vendor) => (
              <button
                key={vendor}
                type="button"
                onClick={() =>
                  void run(`vendor:${vendor}`, () =>
                    rpc("task.setVendor", { taskId: task.id, vendor }),
                  )
                }
                disabled={busy !== null}
                className={`border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                  (task.vendor ?? "claude") === vendor
                    ? "border-primary bg-inset text-fg"
                    : "border-line bg-surface text-muted hover:border-primary hover:text-fg"
                }`}
              >
                {vendor}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <ActionButton
            onClick={() =>
              void run("pin", () =>
                rpc("task.pin", { taskId: task.id, pinned: !task.pinned }),
              )
            }
            disabled={busy !== null}
          >
            {task.pinned ? "Unpin" : "Pin"}
          </ActionButton>
          <ActionButton
            onClick={() =>
              void run("worktree", () =>
                rpc("task.ensureWorktree", { taskId: task.id }),
              )
            }
            disabled={busy !== null}
          >
            Ensure worktree
          </ActionButton>
          <ActionButton onClick={copyPath}>
            {copied ? "Copied" : "Copy path"}
          </ActionButton>
          <ActionButton onClick={archive} disabled={busy !== null} danger>
            Archive
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

export function ToolsPanel() {
  const [tool, setTool] = useState<Tool>("overview")
  const { selectedTaskId } = useTabsState()
  const { tasks } = useAppState()
  const task = selectedTaskId
    ? (tasks.find((t) => t.id === selectedTaskId) ?? null)
    : null

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-line bg-bg lg:flex">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-surface">
        {(["overview", "notes", "changes"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTool(t)}
            className={`px-3 text-[10px] font-bold uppercase tracking-[0.12em] ${
              tool === t
                ? "border-b-2 border-primary text-fg"
                : "text-subtle hover:text-muted"
            }`}
          >
            {t === "overview" ? "Task" : t === "notes" ? "Notes" : "Changes"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tool === "overview" ? (
          <TaskOverview task={task} />
        ) : tool === "notes" ? (
          <NotesPanel taskId={selectedTaskId} full />
        ) : (
          <ChangesList
            worktreePath={task?.worktreePath ?? null}
            onOpenFile={(path) => {
              if (selectedTaskId) openFilePreviewTab(selectedTaskId, path)
            }}
          />
        )}
      </div>
    </aside>
  )
}
