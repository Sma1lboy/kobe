/**
 * IssuePeek — the unified Board's wide story-detail drawer onto one issue, and
 * the owner-specified START surface for turning a story into a task. It rides
 * the shared {@link SlideOver} chrome in its `wide` two-column shell
 * (right-docked, slide-in, focus-trapped, Esc/backdrop close) and splits into:
 *
 *   - LEFT (primary): the story itself — an always-editable title <input> and a
 *     single-surface {@link RichEditor} description. That one Notion-like surface
 *     edits AND renders at once: typing styles inline and pasted/dropped images
 *     upload and appear inline in the same editor. It loads from and emits
 *     markdown, so the issue body stays stored as markdown (issues.json). A
 *     "Save" affordance lights up when the draft differs from the issue.
 *   - RIGHT (a w-72 detail rail): execution config + metadata — the status chip,
 *     created date, a "running" line for a linked issue, and the engine-owned
 *     {@link EngineEffortPicker}. Its bottom holds the start actions.
 *
 * Start actions (owner-explicit): an un-started, startable issue gets TWO
 * buttons — "Start in background" (spawn + stay on the board) and "Start &
 * watch" (spawn + open the live session). A linked issue swaps both for a single
 * "Open session". A done story has nothing to start.
 *
 * RichEditor only inserts images uploaded through the issue-asset endpoint, and
 * markdown.ts only renders those resolved `/api/issue-assets/<hash>/<file>` urls
 * as images, so the paste/upload + render paths stay XSS-safe by construction.
 */

import { ExternalLink, GitMerge, Play } from "lucide-react"
import { useState } from "react"
import {
  canQuickStart,
  type Issue,
  type IssueStartPlacement,
  STATUS_META,
} from "../lib/issues.ts"
import { EngineEffortPicker } from "./EngineEffortPicker.tsx"
import { RichEditor } from "./RichEditor.tsx"
import { SlideOver } from "./SlideOver.tsx"

/** Where the started chat lives — mirrors {@link IssueStartPlacement}. */
const PLACEMENTS: ReadonlyArray<{
  id: IssueStartPlacement
  label: string
  hint: string
}> = [
  {
    id: "task",
    label: "New worktree",
    hint: "isolated branch, tab in its own task workspace",
  },
  {
    id: "projectWorktree",
    label: "Worktree · tab in project",
    hint: "isolated branch, chat tab lives in the project workspace",
  },
  {
    id: "project",
    label: "Project checkout",
    hint: "no worktree — the engine works directly on the checkout",
  },
]

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
  /** Source repo for asset uploads — the same key the Board peeks under. */
  repoRoot: string
  /** A save mutation is in flight — the Save affordance disables. */
  busy: boolean
  /** A start spawn is in flight — both start buttons disable. */
  starting: boolean
  onClose: () => void
  /** Persist the edited story; resolves true on success so we can clear dirty. */
  onSave: (patch: { title: string; body: string }) => Promise<boolean>
  /** Start the issue on the chosen engine/effort at the chosen placement.
   *  `watch` opens the target workspace immediately; otherwise the spawn
   *  stays in the background. */
  onStart: (opts: {
    vendor?: string
    effort?: string
    placement?: IssueStartPlacement
    watch: boolean
  }) => void
  /** Open the running session/workspace for an already-started (linked) issue. */
  onOpenSession?: () => void
  /** Insert the finish/merge prompt into the linked issue task. */
  onPromptMerge?: () => void
}) {
  const [draftTitle, setDraftTitle] = useState(issue.title)
  const [draftBody, setDraftBody] = useState(issue.body)
  const [vendor, setVendor] = useState<string | undefined>(undefined)
  const [effort, setEffort] = useState<string | undefined>(undefined)
  const [placement, setPlacement] = useState<IssueStartPlacement>("task")
  const [error, setError] = useState<string | null>(null)

  // The story is already represented by a live task card on the board, so there
  // is nothing left to start. Done stories likewise have nothing to do.
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
        {/* LEFT — the editable story. */}
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
            {/* Single Notion-like surface: edits AND renders at once, with
                pasted/dropped images inline. Remounts per issue so it seeds from
                this issue's markdown without fighting the cursor mid-edit. */}
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

        {/* RIGHT — execution config + metadata, split into labeled sections so
            future settings/detail each get their own slot (add a sibling
            <section> between Detail and Engine, or after Engine). */}
        <div className="flex w-72 shrink-0 flex-col gap-4 p-3">
          {/* DETAIL */}
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

          {/* ENGINE — its own section; future settings/detail get sibling
              sections beside it. */}
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

          {/* WORKSPACE — where the started chat lives: its own worktree task,
              a worktree whose tab rides the project workspace, or directly on
              the project checkout (no worktree at all). */}
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Workspace
            </h3>
            <div className="flex flex-col gap-1">
              {PLACEMENTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={!startable}
                  onClick={() => setPlacement(option.id)}
                  title={option.hint}
                  className={`border px-2 py-1 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    placement === option.id
                      ? "border-primary bg-inset text-fg"
                      : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
                  }`}
                >
                  <span className="block">{option.label}</span>
                  <span className="block text-[10px] text-subtle">
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* Actions pinned to the rail bottom. */}
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
                  onClick={() =>
                    onStart({ vendor, effort, placement, watch: false })
                  }
                  title="Spawn the session for this story and stay on the board"
                  className="flex h-8 items-center justify-center gap-1.5 border border-line bg-bg px-3 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} strokeWidth={1.8} />
                  {starting ? "Starting…" : "Start in background"}
                </button>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() =>
                    onStart({ vendor, effort, placement, watch: true })
                  }
                  title="Spawn the session and open its workspace"
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
