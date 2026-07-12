/**
 * ToolsPanel — the right rail. A segmented switch between the web-only Notes
 * scratchpad and a compact worktree CHANGES list.
 */

import { useNavigate } from "@tanstack/react-router"
import { X } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import { setActiveTask, setActiveTaskBestEffort } from "../lib/active-task.ts"
import { copyText } from "../lib/clipboard.ts"
import { useEngines } from "../lib/engines.ts"
import { rpc, useAppState } from "../lib/store.ts"
import {
  clearSelectedTask,
  openFilePreviewTab,
  useTabsState,
} from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"
import { ConfirmDialog } from "./ConfirmDialog.tsx"
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

/** Matches the orchestrator's DIRTY_WORKTREE error prefix (the daemon only
 *  ships the message string over the wire — same detection as the TUI). */
const DIRTY_WORKTREE_CODE = "DIRTY_WORKTREE"

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

type PendingConfirm =
  | { kind: "archive" }
  | { kind: "delete"; force: boolean }
  | null

function TaskOverview({ task }: { task: Task | null }) {
  const [title, setTitle] = useState(task?.title ?? "")
  const [branch, setBranch] = useState(task?.branch ?? "")
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    [],
  )
  const [confirm, setConfirm] = useState<PendingConfirm>(null)
  const engines = useEngines()
  const navigate = useNavigate()

  useEffect(() => {
    setTitle(task?.title ?? "")
  }, [task?.title])

  useEffect(() => {
    setBranch(task?.branch ?? "")
  }, [task?.branch])

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
    } catch (err) {
      reportError(key.split(":")[0], err)
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

  const renameBranch = (): void => {
    const next = branch.trim()
    if (!next || next === task.branch) return
    void run("branch", () =>
      rpc("task.setBranch", { taskId: task.id, branch: next }),
    )
  }

  const copyPath = (): void => {
    void copyText(task.worktreePath).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200)
    })
  }

  const archive = (): void => {
    setConfirm(null)
    void run("archive", async () => {
      await rpc("task.archive", { taskId: task.id, archived: true })
      clearSelectedTask()
      void navigate({ to: "/" })
      await setActiveTask(null)
    })
  }

  const restore = (): void => {
    void run("restore", () =>
      rpc("task.archive", { taskId: task.id, archived: false }),
    )
  }

  // Delete flow mirrors the TUI: non-force first; a DIRTY_WORKTREE rejection
  // re-prompts with an explicit force confirm so uncommitted work can't be
  // lost on a single click.
  const doDelete = (force: boolean): void => {
    setConfirm(null)
    setBusy("delete")
    void (async () => {
      try {
        await rpc("task.delete", { taskId: task.id, force })
        clearSelectedTask()
        void navigate({ to: "/" })
        setActiveTaskBestEffort(null)
        pushToast("success", `Deleted "${task.title || task.branch}"`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!force && message.includes(DIRTY_WORKTREE_CODE)) {
          setConfirm({ kind: "delete", force: true })
        } else {
          reportError("delete", err)
        }
      } finally {
        setBusy(null)
      }
    })()
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
        {task.archived && (
          <div className="mt-2 flex items-center justify-between gap-2 border border-kobe-yellow/40 bg-kobe-yellow/10 px-2 py-1.5">
            <span className="text-[11px] text-kobe-yellow">archived</span>
            <ActionButton onClick={restore} disabled={busy !== null}>
              Restore
            </ActionButton>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {task.kind === "main" ? (
          <Field name="Branch" value={task.branch} mono />
        ) : (
          <div className="min-w-0 border-b border-line-subtle py-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Branch
            </div>
            <div className="mt-1 flex gap-2">
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                onBlur={renameBranch}
                onKeyDown={(event) => {
                  if (event.key === "Enter") renameBranch()
                }}
                className="min-w-0 flex-1 border border-line bg-bg px-2 py-1 font-mono text-[12px] text-fg focus:border-line-active focus:outline-none"
              />
            </div>
          </div>
        )}
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
            {engines.map((engine) => (
              <button
                key={engine.id}
                type="button"
                onClick={() =>
                  void run(`vendor:${engine.id}`, () =>
                    rpc("task.setVendor", {
                      taskId: task.id,
                      vendor: engine.id,
                    }),
                  )
                }
                disabled={busy !== null}
                className={`border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                  (task.vendor ?? "claude") === engine.id
                    ? "border-primary bg-inset text-fg"
                    : "border-line bg-surface text-muted hover:border-primary hover:text-fg"
                }`}
              >
                {engine.label}
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
          {!task.archived && (
            <ActionButton
              onClick={() => setConfirm({ kind: "archive" })}
              disabled={busy !== null}
              danger
            >
              Archive
            </ActionButton>
          )}
        </div>

        {task.kind !== "main" && (
          <div className="mt-4 border-t border-line-subtle pt-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Danger zone
            </div>
            <ActionButton
              onClick={() => setConfirm({ kind: "delete", force: false })}
              disabled={busy !== null}
              danger
            >
              Delete task + worktree
            </ActionButton>
          </div>
        )}
      </div>

      {confirm?.kind === "archive" && (
        <ConfirmDialog
          title="Archive task"
          body={`Archive "${task.title || task.branch}"? Its Hosted PTY sessions will be stopped; the worktree stays on disk and the task can be restored from the Archived section.`}
          confirmLabel="Archive"
          danger
          busy={busy === "archive"}
          onConfirm={archive}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title={
            confirm.force ? "Worktree has uncommitted changes" : "Delete task"
          }
          body={
            confirm.force
              ? `"${task.title || task.branch}" has uncommitted or untracked changes in its worktree. Force-delete discards them permanently.`
              : `Delete "${task.title || task.branch}"? This removes the task, kills its engine session, and removes its worktree (branch history stays in git).`
          }
          confirmLabel={confirm.force ? "Force delete" : "Delete"}
          danger
          busy={busy === "delete"}
          onConfirm={() => doDelete(confirm.force)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

export function ToolsPanel({
  drawer = false,
  onClose,
}: {
  /** Drawer mode (narrow screens): fills its container + shows a close ×.
   *  Default (lg+ column): fixed 20rem width, no close button. */
  drawer?: boolean
  onClose?: () => void
} = {}) {
  const [tool, setTool] = useState<Tool>("overview")
  const { selectedTaskId } = useTabsState()
  const { tasks } = useAppState()
  const task = selectedTaskId
    ? (tasks.find((t) => t.id === selectedTaskId) ?? null)
    : null

  return (
    <aside
      className={
        drawer
          ? "flex h-full w-full flex-col bg-bg"
          : "flex w-80 shrink-0 flex-col border-l border-line bg-bg"
      }
    >
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
        {drawer && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3 text-subtle hover:text-fg"
            aria-label="Close tools"
          >
            <X size={14} strokeWidth={2} />
          </button>
        )}
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
