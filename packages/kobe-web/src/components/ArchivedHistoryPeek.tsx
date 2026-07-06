/**
 * ArchivedHistoryPeek — beta read-only preview of an archived task's engine
 * history (Settings → Experimental → "Archived history preview").
 *
 * An archived task's git worktree is usually gone (it was archived precisely
 * because `git worktree remove` ran). Its transcript, however, lives in the
 * engine's own vendor store keyed by the worktree PATH STRING — claude's
 * `~/.claude/projects/<encoded-path>/*`, codex's `~/.codex/sessions/**` — which
 * the deletion never touched. So `ChatTranscript`, which already reads through
 * the neutral `/api/history/*` routes keyed by `worktreePath` + `vendor`, renders
 * the full history unchanged; we just host it in a docked drawer with no live
 * PTY / engine tab. Pure read surface — no write path is wired here.
 */

import type { Task } from "../lib/types.ts"
import { ChatTranscript } from "./ChatTranscript.tsx"
import { SlideOver } from "./SlideOver.tsx"

export function ArchivedHistoryPeek({
  task,
  onClose,
}: {
  /** The archived task to preview, or null when the drawer is closed. */
  task: Task | null
  onClose: () => void
}) {
  return (
    <SlideOver
      open={task !== null}
      onClose={onClose}
      title={
        task ? (
          <span className="flex items-center gap-2">
            <span className="shrink-0 border border-line px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-subtle">
              Archived
            </span>
            <span className="min-w-0 truncate">
              {task.title || task.branch}
            </span>
          </span>
        ) : undefined
      }
    >
      {task && (
        <ChatTranscript
          worktreePath={task.worktreePath ?? null}
          vendor={task.vendor ?? "claude"}
          title={task.title || task.branch}
        />
      )}
    </SlideOver>
  )
}
