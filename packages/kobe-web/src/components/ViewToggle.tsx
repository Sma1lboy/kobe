/**
 * ViewToggle — the top-left peer switch between Workspace, Board, and
 * Worktrees. They are PEER views (no back link): a segmented control that
 * reads the current pathname from the router and navigates between the
 * surfaces.
 *
 * "Workspace" routes to the selected task (/task/$taskId from the persisted
 * tab selection) so the toggle lands you on a real task, falling back to the
 * index when nothing is selected. "Board" routes to /board. "Worktrees"
 * routes to /worktrees.
 */

import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Columns3, GitBranch, PanelsTopLeft } from "lucide-react"
import { useTabsState } from "../lib/tabs.ts"

type View = "workspace" | "board" | "worktrees"

export function ViewToggle() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { selectedTaskId } = useTabsState()
  const view: View = pathname.startsWith("/board")
    ? "board"
    : pathname.startsWith("/worktrees")
      ? "worktrees"
      : "workspace"

  const goTo = (target: View): void => {
    if (view === target) return
    if (target === "workspace") {
      if (selectedTaskId) {
        void navigate({
          to: "/task/$taskId",
          params: { taskId: selectedTaskId },
        })
      } else {
        void navigate({ to: "/" })
      }
      return
    }
    void navigate({ to: target === "board" ? "/board" : "/worktrees" })
  }

  const tabClass = (active: boolean): string =>
    `flex items-center gap-1.5 border-l border-line px-2 py-1 text-[11px] transition-colors first:border-l-0 ${
      active
        ? "border-line-active bg-inset text-fg"
        : "text-subtle hover:text-fg"
    }`

  return (
    <div className="flex items-center overflow-hidden rounded-sm border border-line">
      <button
        type="button"
        onClick={() => goTo("workspace")}
        aria-pressed={view === "workspace"}
        title="Workspace"
        className={tabClass(view === "workspace")}
      >
        <PanelsTopLeft size={13} strokeWidth={1.8} />
        Workspace
      </button>
      <button
        type="button"
        onClick={() => goTo("board")}
        aria-pressed={view === "board"}
        title="Board"
        className={tabClass(view === "board")}
      >
        <Columns3 size={13} strokeWidth={1.8} />
        Board
      </button>
      <button
        type="button"
        onClick={() => goTo("worktrees")}
        aria-pressed={view === "worktrees"}
        title="Worktrees"
        className={tabClass(view === "worktrees")}
      >
        <GitBranch size={13} strokeWidth={1.8} />
        Worktrees
      </button>
    </div>
  )
}
