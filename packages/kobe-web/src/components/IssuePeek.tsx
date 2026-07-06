import { ExternalLink, GitMerge, Play } from "lucide-react"
import { useState } from "react"
import { canQuickStart, type Issue, STATUS_META } from "../lib/issues.ts"
import { EngineEffortPicker } from "./EngineEffortPicker.tsx"
import { RichEditor } from "./RichEditor.tsx"
import { SlideOver } from "./SlideOver.tsx"

export function IssuePeek({
  issue,
  repoRoot,
  busy,
  starting,
  onClose,
  onSave,
  onStart,
  onOpenSession,
  onPromptMerge,
}: {
  issue: Issue
  repoRoot: string
  busy: boolean
  starting: boolean
  onClose: () => void
  onSave: (patch: { title: string; body: string }) => Promise<boolean>
  onStart: (opts: { vendor?: string; effort?: string; watch: boolean }) => void
  onOpenSession?: () => void
  onPromptMerge?: () => void
}) {
  const [draftTitle, setDraftTitle] = useState(issue.title)
  const [draftBody, setDraftBody] = useState(issue.body)
  const [vendor, setVendor] = useState<string | undefined>(undefined)
  const [effort, setEffort] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const linked = Boolean(issue.taskId)
  const startable = canQuickStart(issue.status) && !linked
  const dirty = draftTitle !== issue.title || draftBody !== issue.body
  const canSave = dirty && draftTitle.trim().length > 0 && !busy

  const meta = STATUS_META[issue.status]

  const save = (): void => {
    if (!canSave) return
    setError(null)
    void onSave({ title: draftTitle, body: draftBody }).catch(
      (err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to save issue")
      },
    )
  }

  const title = (
    <span className="flex items-center gap-2">
      <span className="shrink-0 font-mono text-[11px] text-subtle">
        #{issue.id}
      </span>
      <span className="min-w-0 truncate">{issue.title}</span>
    </span>
  )

  return (
    <SlideOver open wide onClose={onClose} title={title}>
      <div className="flex h-full min-h-0">
        {}
        <div className="flex min-w-0 flex-1 flex-col gap-3 border-r border-line p-3">
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Title
            </div>
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Issue title"
              className="w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
                Acceptance
              </span>
              <span className="text-[10px] text-subtle">
                paste or drop images
              </span>
            </div>
            {}
            <RichEditor
              key={issue.id}
              value={draftBody}
              onChange={setDraftBody}
              repoRoot={repoRoot}
              placeholder="context, constraints, acceptance criteria — paste a screenshot to attach it"
            />
          </div>

          {error && (
            <p className="text-[11px] text-kobe-red" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!canSave}
              onClick={save}
              title={dirty ? "Save title and body" : "No unsaved changes"}
              className="border border-primary bg-inset px-3 py-1 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {}
        <div className="flex w-72 shrink-0 flex-col gap-4 p-3">
          {}
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Detail
            </h3>
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] font-bold uppercase tracking-[0.12em] ${meta.accent}`}
              >
                {meta.title}
              </span>
              <span className="font-mono text-[10px] text-subtle">
                created {issue.created}
              </span>
            </div>
            {linked && issue.taskId && (
              <span
                className="flex items-center gap-1.5 font-mono text-[10px] text-kobe-orange"
                title={`Linked to task ${issue.taskId}`}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-kobe-orange" />
                running
              </span>
            )}
          </section>

          {}
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Engine
            </h3>
            <EngineEffortPicker
              vendor={vendor}
              effort={effort}
              disabled={!startable}
              onChange={(next) => {
                setVendor(next.vendor)
                setEffort(next.effort)
              }}
            />
          </section>

          {}
          <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3">
            {linked ? (
              <>
                <button
                  type="button"
                  onClick={() => onOpenSession?.()}
                  disabled={!onOpenSession}
                  title="Open this story's running session in the workspace"
                  className="flex h-8 items-center justify-center gap-1.5 border border-primary bg-inset px-3 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ExternalLink size={12} strokeWidth={1.8} />
                  Open session
                </button>
                <button
                  type="button"
                  onClick={() => onPromptMerge?.()}
                  disabled={!onPromptMerge || starting}
                  title="Insert the finish and merge prompt into this story's task"
                  className="flex h-8 items-center justify-center gap-1.5 border border-line bg-bg px-3 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <GitMerge size={12} strokeWidth={1.8} />
                  Prompt merge
                </button>
                <span className="text-center text-[10px] text-subtle">
                  Started
                </span>
              </>
            ) : startable ? (
              <>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => onStart({ vendor, effort, watch: false })}
                  title="Spawn a kobe task session for this story and stay on the board"
                  className="flex h-8 items-center justify-center gap-1.5 border border-line bg-bg px-3 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} strokeWidth={1.8} />
                  {starting ? "Starting…" : "Start in background"}
                </button>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => onStart({ vendor, effort, watch: true })}
                  title="Spawn a kobe task session and open it"
                  className="flex h-8 items-center justify-center gap-1.5 border border-primary bg-inset px-3 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} strokeWidth={1.8} />
                  {starting ? "Starting…" : "Start & watch"}
                </button>
              </>
            ) : (
              <p className="text-center text-[10px] text-subtle">
                Done stories have nothing left to start.
              </p>
            )}
          </div>
        </div>
      </div>
    </SlideOver>
  )
}
