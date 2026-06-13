/**
 * Adopt-worktree dialog — onboarding for existing git worktrees kobe hasn't
 * tracked yet. Pick a known repo, the daemon lists adoptable worktrees
 * (worktree.discoverAdoptable), and one click adopts each into a task
 * (worktree.adopt). Lets the web dashboard pull in pre-existing worktrees
 * without dropping to the TUI/CLI.
 */

import { useNavigate } from "@tanstack/react-router"
import { useMemo, useRef, useState } from "react"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { relativeTimeAgo } from "../lib/time.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"
import { NewTaskDialog } from "./NewTaskDialog.tsx"

interface AdoptableWorktree {
  path: string
  branch: string
  head: string
  dirty: boolean
  kobeManaged: boolean
  lastActivityMs: number
}

export function AdoptDialog({ onClose }: { onClose: () => void }) {
  const { tasks } = useAppState()
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const repos = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const task of tasks as Task[]) {
      if (task.repo && !seen.has(task.repo)) {
        seen.add(task.repo)
        list.push(task.repo)
      }
    }
    return list.sort()
  }, [tasks])

  // Worktree paths already mapped to a task — adopting them again is a no-op,
  // so they're shown as "tracked" rather than offered.
  const trackedPaths = useMemo(
    () => new Set((tasks as Task[]).map((t) => t.worktreePath).filter(Boolean)),
    [tasks],
  )

  const [repo, setRepo] = useState(repos[0] ?? "")
  const [worktrees, setWorktrees] = useState<AdoptableWorktree[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [adopting, setAdopting] = useState<string | null>(null)
  // Zero-known-repos is a dead end for adoption (nothing to scan), so the
  // button swaps this overlay for the real New Task dialog — its onClose closes
  // the whole flow, same as adopting.
  const [creating, setCreating] = useState(false)

  const scan = async (target: string): Promise<void> => {
    if (!target) return
    setScanning(true)
    setWorktrees(null)
    try {
      const { worktrees: found } = await rpc<{
        worktrees: AdoptableWorktree[]
      }>("worktree.discoverAdoptable", { repo: target })
      setWorktrees(found)
    } catch (err) {
      reportError("scan worktrees", err)
      setWorktrees([])
    } finally {
      setScanning(false)
    }
  }

  const adopt = async (wt: AdoptableWorktree): Promise<void> => {
    setAdopting(wt.path)
    try {
      const { task } = await rpc<{ task: Task }>("worktree.adopt", {
        repo,
        worktreePath: wt.path,
        branch: wt.branch,
        ifExists: "return",
      })
      selectTask(task.id)
      void rpc("task.setActive", { taskId: task.id }).catch(() => {})
      void navigate({ to: "/task/$taskId", params: { taskId: task.id } })
      pushToast("success", `Adopted ${wt.branch || wt.path}`)
      onClose()
    } catch (err) {
      reportError("adopt worktree", err)
    } finally {
      setAdopting(null)
    }
  }

  // No repos known yet → adoption can't go anywhere. Hand off to the real New
  // Task dialog so the user can create a task in a repo and come back.
  if (creating) return <NewTaskDialog onClose={onClose} />

  if (repos.length === 0) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss; Escape + Close are the keyboard paths.
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
        onClick={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
        role="presentation"
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Adopt worktree"
          className="flex w-[32rem] max-w-[calc(100vw-2rem)] flex-col border border-line bg-surface shadow-xl"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={() => {}}
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
              Adopt worktree
            </span>
            <span className="font-mono text-[10px] text-subtle">
              pull an existing worktree into kobe
            </span>
          </div>

          <div className="px-3 py-6 text-center">
            <p className="text-[12px] leading-relaxed text-subtle">
              No repos known to kobe yet. Create a task in a repo first, then
              come back to adopt its worktrees.
            </p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-4 border border-primary bg-inset px-3 py-1.5 text-[11px] text-fg transition-colors hover:bg-primary/10"
            >
              Create a task
            </button>
          </div>

          <div className="flex justify-end border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-line bg-bg px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss; Escape + Cancel are the keyboard paths.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose()
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Adopt worktree"
        className="flex max-h-[80vh] w-[32rem] max-w-[calc(100vw-2rem)] flex-col border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
            Adopt worktree
          </span>
          <span className="font-mono text-[10px] text-subtle">
            pull an existing worktree into kobe
          </span>
        </div>

        <div className="space-y-2 px-3 py-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
            Repo
          </div>
          <div className="flex gap-2">
            <select
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              className="min-w-0 flex-1 border border-line bg-bg px-2 py-1.5 text-[12px] text-fg focus:border-line-active focus:outline-none"
            >
              {repos.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void scan(repo)}
              disabled={!repo || scanning}
              className="shrink-0 border border-primary bg-inset px-3 py-1.5 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              {scanning ? "Scanning…" : "Scan"}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          {worktrees === null ? (
            <p className="px-3 py-6 text-center text-[12px] text-subtle">
              Pick a repo and Scan to find adoptable worktrees.
            </p>
          ) : worktrees.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-subtle">
              No adoptable worktrees found for this repo.
            </p>
          ) : (
            worktrees.map((wt) => {
              const tracked = trackedPaths.has(wt.path)
              return (
                <div
                  key={wt.path}
                  className="flex items-center gap-2 border-b border-line-subtle px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px] text-fg">
                        {wt.branch || "(detached)"}
                      </span>
                      {wt.dirty && (
                        <span className="shrink-0 text-[10px] text-kobe-yellow">
                          dirty
                        </span>
                      )}
                      {wt.kobeManaged && (
                        <span className="shrink-0 text-[10px] text-subtle">
                          kobe
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-subtle">
                      <span className="truncate font-mono">{wt.path}</span>
                      {wt.lastActivityMs > 0 && (
                        <span className="ml-auto shrink-0">
                          {relativeTimeAgo(wt.lastActivityMs)}
                        </span>
                      )}
                    </div>
                  </div>
                  {tracked ? (
                    <span className="shrink-0 text-[10px] text-subtle">
                      tracked
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void adopt(wt)}
                      disabled={adopting !== null}
                      className="shrink-0 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:opacity-40"
                    >
                      {adopting === wt.path ? "Adopting…" : "Adopt"}
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="flex justify-end border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-line bg-bg px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
