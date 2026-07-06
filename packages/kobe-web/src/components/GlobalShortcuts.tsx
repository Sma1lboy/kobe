import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import {
  closeCommandPalette,
  closeKeyboardHelp,
  closeNewTask,
  openKeyboardHelp,
  openNewTask,
  openSettings,
  toggleCommandPalette,
  useGlobalUiState,
} from "../lib/global-ui.ts"
import { setNotifyNavigate } from "../lib/notify.ts"
import { selectTask } from "../lib/tabs.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { KeyboardHelp } from "./KeyboardHelp.tsx"
import { NewTaskDialog } from "./NewTaskDialog.tsx"
import { Toasts } from "./Toasts.tsx"

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable
  )
}

export function GlobalShortcuts() {
  const { paletteOpen, helpOpen, newTaskOpen } = useGlobalUiState()
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        toggleCommandPalette()
        return
      }
      if (
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault()
        openKeyboardHelp()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    setNotifyNavigate((taskId) => {
      selectTask(taskId)
      setActiveTaskBestEffort(taskId)
      void navigate({ to: "/task/$taskId", params: { taskId } })
    })
    return () => setNotifyNavigate(null)
  }, [navigate])

  return (
    <>
      {helpOpen && <KeyboardHelp onClose={closeKeyboardHelp} />}
      {newTaskOpen && <NewTaskDialog onClose={closeNewTask} />}
      <CommandPalette
        open={paletteOpen}
        onClose={closeCommandPalette}
        onNewTask={openNewTask}
        onOpenSettings={() => {
          openSettings()
          void navigate({ to: "/" })
        }}
      />
      <Toasts />
    </>
  )
}
