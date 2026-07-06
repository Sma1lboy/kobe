import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { AppShell } from "../components/AppShell.tsx"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import { selectTask, useTabsState } from "../lib/tabs.ts"

function TaskRoute() {
  const { taskId } = Route.useParams()
  const { selectedTaskId } = useTabsState()

  useEffect(() => {
    if (!taskId || taskId === selectedTaskId) return
    selectTask(taskId)
    setActiveTaskBestEffort(taskId)
  }, [taskId, selectedTaskId])

  return <AppShell />
}

export const Route = createFileRoute("/task/$taskId")({ component: TaskRoute })
