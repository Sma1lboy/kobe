import { createRouter, RouterProvider } from "@tanstack/react-router"
import ReactDOM from "react-dom/client"
import { enableDesktopMode, preloadDesktopModules } from "./lib/desktop.ts"
import { routeTree } from "./routeTree.gen"

const desktopMode = enableDesktopMode()

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById("app")

if (!rootElement) {
  throw new Error("missing #app root element")
}

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<RouterProvider router={router} />)
  if (desktopMode) void preloadDesktopModules()
}
