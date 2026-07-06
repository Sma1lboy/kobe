import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import { useEngines } from "../lib/engines.ts"
import { fetchDefaultEngine } from "../lib/settings.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { addTab, selectTask, setPendingPrompt } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import type { Task } from "../lib/types.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"
import { engineLabel } from "../lib/vendor.ts"

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
      {children}
    </div>
  )
}

const inputClass =
  "w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const { tasks } = useAppState()
  const engines = useEngines()
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const repos = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const task of tasks as Task[]) {
      const repo = task.repo
      if (repo && !seen.has(repo)) {
        seen.add(repo)
        list.push(repo)
      }
    }
    return list.sort()
  }, [tasks])

  const [repo, setRepo] = useState(repos[0] ?? "")
  const [customRepo, setCustomRepo] = useState(false)
  const [title, setTitle] = useState("")
  const [branch, setBranch] = useState("")
  const [baseRef, setBaseRef] = useState("")
  const [vendor, setVendor] = useState<string>(engines[0]?.id ?? "claude")
  const [vendorTouched, setVendorTouched] = useState(false)
  const [firstPrompt, setFirstPrompt] = useState("")
  const [busy, setBusy] = useState(false)

  const canCreate = repo.trim().length > 0 && !busy

  useEffect(() => {
    let cancelled = false
    void fetchDefaultEngine().then((id) => {
      if (cancelled || !id || vendorTouched) return
      setVendor(id)
    })
    return () => {
      cancelled = true
    }
  }, [vendorTouched])

  const create = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    try {
      const payload: Record<string, string> = { repo: repo.trim() }
      if (title.trim()) payload.title = title.trim()
      if (branch.trim()) payload.branch = branch.trim()
      if (baseRef.trim()) payload.baseRef = baseRef.trim()
      if (vendor) payload.vendor = vendor
      const { taskId, task } = await rpc<{ taskId: string; task: Task }>(
        "task.create",
        payload,
      )
      selectTask(taskId)
      const prompt = firstPrompt.trim()
      if (prompt) {
        setPendingPrompt(taskId, prompt)
        addTab(taskId)
      }
      void navigate({ to: "/task/$taskId", params: { taskId } })
      setActiveTaskBestEffort(taskId)
      pushToast(
        "success",
        `Task created: ${task?.title || task?.branch || taskId}`,
      )
      onClose()
    } catch (err) {
      reportError("create task", err)
    } finally {
      setBusy(false)
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is a convenience; Escape + the Cancel button are the accessible paths.
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
        aria-label="New task"
        className="w-[28rem] max-w-[calc(100vw-2rem)] border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
            New Task
          </span>
          <span className="font-mono text-[10px] text-subtle">
            worktree + engine session
          </span>
        </div>

        <form
          className="space-y-3 px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <div>
            <FieldLabel>Repo</FieldLabel>
            {repos.length > 0 && !customRepo ? (
              <div className="flex gap-2">
                <select
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  className={`${inputClass} min-w-0 flex-1`}
                >
                  {repos.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setCustomRepo(true)
                    setRepo("")
                  }}
                  className="shrink-0 border border-line bg-bg px-2 text-[11px] text-muted hover:border-primary hover:text-fg"
                  title="Type a repo path instead"
                >
                  path…
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="/absolute/path/to/repo"
                  className={`${inputClass} min-w-0 flex-1 font-mono`}
                />
                {repos.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setCustomRepo(false)
                      setRepo(repos[0] ?? "")
                    }}
                    className="shrink-0 border border-line bg-bg px-2 text-[11px] text-muted hover:border-primary hover:text-fg"
                    title="Pick a known repo"
                  >
                    list
                  </button>
                )}
              </div>
            )}
          </div>

          <div>
            <FieldLabel>Title</FieldLabel>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="optional — auto-titled from the first message"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>Branch</FieldLabel>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="auto"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <FieldLabel>Base ref</FieldLabel>
              <input
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                placeholder="default branch"
                className={`${inputClass} font-mono`}
              />
            </div>
          </div>

          <div>
            <FieldLabel>Engine</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {engines.map((engine) => (
                <button
                  key={engine.id}
                  type="button"
                  onClick={() => {
                    setVendorTouched(true)
                    setVendor(engine.id)
                  }}
                  className={`border px-2 py-1 text-[11px] transition-colors ${
                    vendor === engine.id
                      ? "border-primary bg-inset text-fg"
                      : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
                  }`}
                >
                  {engineLabel(engines, engine.id)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>First prompt</FieldLabel>
            <textarea
              value={firstPrompt}
              onChange={(event) => setFirstPrompt(event.target.value)}
              placeholder="optional — waits in the engine composer, ready to send"
              rows={2}
              className={`${inputClass} resize-none`}
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={onClose}
              className="border border-line bg-bg px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="border border-primary bg-inset px-3 py-1.5 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
