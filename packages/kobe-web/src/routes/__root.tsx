import { createRootRoute, Outlet } from "@tanstack/react-router"
import { useEffect } from "react"
import { ErrorBoundary } from "../components/ErrorBoundary.tsx"
import { GlobalShortcuts } from "../components/GlobalShortcuts.tsx"
import { attentionCount, documentTitle } from "../lib/document-title.ts"
import { useAppState } from "../lib/store.ts"

import "../styles.css"

export const Route = createRootRoute({
  component: RootComponent,
})

function useAttentionTitle(): void {
  const { tasks, engineStates } = useAppState()
  useEffect(() => {
    document.title = documentTitle(attentionCount(tasks, engineStates))
  }, [tasks, engineStates])
}

function RootComponent() {
  useAttentionTitle()
  return (
    <ErrorBoundary>
      <Outlet />
      <GlobalShortcuts />
    </ErrorBoundary>
  )
}
