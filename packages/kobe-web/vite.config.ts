import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"

import { tanstackRouter } from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const daemonWebPort = process.env.KOBE_DAEMON_WEB_PORT ?? "5174"
const daemonWebTarget = `http://localhost:${daemonWebPort}`
const ptyPort = process.env.KOBE_PTY_PORT ?? "5175"

const config = defineConfig({
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
