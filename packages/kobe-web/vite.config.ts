import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"

import { tanstackRouter } from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// `kobe web --bridge-only` asks the daemon to bind HTTP/SSE routes on a
// sibling port. Vite proxies those routes so the browser sees one origin.
const bridgePort = process.env.KOBE_BRIDGE_PORT ?? "5174"
const bridgeTarget = `http://localhost:${bridgePort}`
// The PTY terminal lives in a separate node process (node-pty doesn't work
// under bun). Proxy its WebSocket here so the browser stays single-origin.
const ptyPort = process.env.KOBE_PTY_PORT ?? "5175"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      "/api": { target: bridgeTarget, changeOrigin: true },
      "/events": { target: bridgeTarget, changeOrigin: true, ws: false },
      "/pty": {
        target: `ws://localhost:${ptyPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
  ],
})

export default config
