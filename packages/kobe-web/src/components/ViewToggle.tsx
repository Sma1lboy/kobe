/**
 * ViewToggle — the top-left peer switch between the Workspace and the Board.
 * They are PEER views (no back link): a segmented two-button control that
 * reads the current pathname from the router and navigates between the two
 * surfaces.
 *
 * "Workspace" routes to the selected task (/task/$taskId from the persisted
 * tab selection) so the toggle lands you on a real task, falling back to the
 * index when nothing is selected. "Board" routes to /board.
 */

import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Columns3, PanelsTopLeft } from "lucide-react"
import { useTabsState } from "../lib/tabs.ts"

export function ViewToggle() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { selectedTaskId } = useTabsState()
  const onBoard = pathname.startsWith("/board")

  const goWorkspace = (): void => {
    if (onBoard === false) return
    if (selectedTaskId)
      void navigate({ to: "/task/$taskId", params: { taskId: selectedTaskId } })
    else void navigate({ to: "/" })
  }
  const goBoard = (): void => {
    if (onBoard) return
    void navigate({ to: "/board" })
  }

  return (
    <div className="flex items-center overflow-hidden rounded-sm border border-line">
      <button
        type="button"
        onClick={goWorkspace}
        aria-pressed={!onBoard}
        title="Workspace"
        className={`flex items-center gap-1.5 px-2 py-1 text-[11px] transition-colors ${
          !onBoard
            ? "border-line-active bg-inset text-fg"
            : "text-subtle hover:text-fg"
        }`}
      >
        <PanelsTopLeft size={13} strokeWidth={1.8} />
        Workspace
      </button>
      <button
        type="button"
        onClick={goBoard}
        aria-pressed={onBoard}
        title="Board"
        className={`flex items-center gap-1.5 border-l border-line px-2 py-1 text-[11px] transition-colors ${
          onBoard
            ? "border-line-active bg-inset text-fg"
            : "text-subtle hover:text-fg"
        }`}
      >
        <Columns3 size={13} strokeWidth={1.8} />
        Board
      </button>
    </div>
  )
}
