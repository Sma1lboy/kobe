import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"

import { tanstackRouter } from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The daemon binds browser-facing HTTP/SSE routes on a sibling port. Vite
// proxies those routes so the browser sees one origin during development.
const daemonWebPort = process.env.KOBE_DAEMON_WEB_PORT ?? "5174"
const daemonWebTarget = `http://localhost:${daemonWebPort}`
// The PTY terminal lives in a separate node process (node-pty doesn't work
// under bun). Proxy its WebSocket here so the browser stays single-origin.
const ptyPort = process.env.KOBE_PTY_PORT ?? "5175"

const config = defineConfig({
  // Dedupe React to ONE copy. The monorepo has two React versions on disk
  // (kobe-web pins ^19.2, branding pins 19.0); @dnd-kit's loose `react
  // >=16.8` peer otherwise lets the board's drag hooks resolve the other
  // copy, so useSortable runs against a second React dispatcher → "Invalid
  // hook call" in dev and a duplicated runtime in the bundle.
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  server: {
    proxy: {
      "/api": { target: daemonWebTarget, changeOrigin: true },
      "/events": { target: daemonWebTarget, changeOrigin: true, ws: false },
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
