/**
 * Root-level web affordances. Board/Issues bypass AppShell, so shortcut
 * overlays and toast delivery have to live above the route outlet.
 */

import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import {
  closeCommandPalette,
  closeKeyboardHelp,
  closeNewTask,
  openKeyboardHelp,
  selectChatTask,
  openNewTask,
  openSettings,
  openCommandPalette,
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
      // Open only — while open, the palette itself owns ctrl+k (hold-to-cycle).
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openCommandPalette()
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

  // Let notification clicks jump to their task from any route — the /chat
  // shell (home) owns task selection now.
  useEffect(() => {
    setNotifyNavigate((taskId) => {
      selectTask(taskId)
      setActiveTaskBestEffort(taskId)
      selectChatTask(taskId)
      void navigate({ to: "/" })
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
