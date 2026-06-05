/**
 * ToolsPanel — the right rail. A segmented switch between the web-only Notes
 * scratchpad and a compact worktree CHANGES list.
 */

import { useState } from "react"
import { useAppState } from "../lib/store.ts"
import { openFilePreviewTab, useTabsState } from "../lib/tabs.ts"
import { ChangesList } from "./DiffView.tsx"
import { NotesPanel } from "./NotesPanel.tsx"

type Tool = "notes" | "changes"

export function ToolsPanel() {
  const [tool, setTool] = useState<Tool>("notes")
  const { selectedTaskId } = useTabsState()
  const { tasks } = useAppState()
  const task = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-line bg-bg lg:flex">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-surface">
        {(["notes", "changes"] as const).map((t) => (
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
            {t === "notes" ? "Notes" : "Changes"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tool === "notes" ? (
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
