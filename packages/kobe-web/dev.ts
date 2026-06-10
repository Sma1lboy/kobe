/**
 * Dev launcher — one `bun run dev` brings up the whole web UI:
 *   - the bridge server (bun, ./server) on KOBE_BRIDGE_PORT (5174)
 *   - the Vite dev server (node) on 5173, proxying /api + /events to it
 *
 * The bridge is a standalone process that talks to the daemon over the
 * socket protocol — it runs under `bun --watch`, so editing server/ code
 * hot-restarts the bridge WITHOUT touching the daemon (or your tasks).
 * Ctrl-C tears everything down.
 */

const BRIDGE_PORT = process.env.KOBE_BRIDGE_PORT ?? "5174"
const WEB_PORT = process.env.KOBE_WEB_PORT ?? "5173"
const PTY_PORT = process.env.KOBE_PTY_PORT ?? "5175"

// bun: bridge server (SSE/RPC/notes/diff/session) — daemon client, not daemon-hosted.
const bridge = Bun.spawn(["bun", "--watch", "server/main.ts"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, KOBE_BRIDGE_PORT: BRIDGE_PORT },
})

// node: PTY terminal server — node-pty only works under node, not bun.
// Needs the bridge port to fetch each tab's engine launch spec.
const pty = Bun.spawn(["node", "pty-server.mjs"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, KOBE_PTY_PORT: PTY_PORT, KOBE_BRIDGE_PORT: BRIDGE_PORT },
})

// node (via vite): the SPA, proxying /api + /events + /pty to the above.
const vite = Bun.spawn(["bun", "run", "vite", "dev", "--port", WEB_PORT, "--strictPort"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, KOBE_BRIDGE_PORT: BRIDGE_PORT, KOBE_PTY_PORT: PTY_PORT },
})

const shutdown = (): void => {
  bridge.kill()
  pty.kill()
  vite.kill()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("exit", shutdown)

// If any child exits, bring the whole dev session down.
void Promise.race([bridge.exited, pty.exited, vite.exited]).then(() => {
  shutdown()
  process.exit(0)
})
