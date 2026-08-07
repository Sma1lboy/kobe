import "@fontsource/jetbrains-mono/latin-400.css"
import "@fontsource/jetbrains-mono/latin-500.css"
import "@fontsource/jetbrains-mono/latin-600.css"
import "@fontsource/jetbrains-mono/latin-700.css"
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
