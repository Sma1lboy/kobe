/**
 * Deep link to one task: /task/<taskId> selects the task and renders the
 * normal shell. Makes tasks linkable/refresh-safe and gives browser
 * back/forward real meaning (TaskRail clicks push these URLs). An unknown
 * id falls back to the empty-workspace state once the snapshot proves the
 * task is gone (pruneMissingTasks clears the selection).
 */

import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { AppShell } from "../components/AppShell.tsx"
import { rpc } from "../lib/store.ts"
import { selectTask, useTabsState } from "../lib/tabs.ts"

function TaskRoute() {
  const { taskId } = Route.useParams()
  const { selectedTaskId } = useTabsState()

  useEffect(() => {
    if (!taskId || taskId === selectedTaskId) return
    selectTask(taskId)
    void rpc("task.setActive", { taskId }).catch(() => {})
  }, [taskId, selectedTaskId])

  return <AppShell />
}

export const Route = createFileRoute("/task/$taskId")({ component: TaskRoute })
