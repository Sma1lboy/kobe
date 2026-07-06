import type { Task } from "../lib/types.ts"
import { ChatTranscript } from "./ChatTranscript.tsx"
import { SlideOver } from "./SlideOver.tsx"

export function ArchivedHistoryPeek({
  task,
  onClose,
}: {
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
