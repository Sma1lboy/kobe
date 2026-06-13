import { createRootRoute, Outlet } from "@tanstack/react-router"
import { ErrorBoundary } from "../components/ErrorBoundary.tsx"

import "../styles.css"

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <ErrorBoundary>
      <Outlet />
    </ErrorBoundary>
  )
}
