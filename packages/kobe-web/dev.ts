/**
 * Dev launcher — one `bun run dev` brings up the whole web UI:
 *   - the transitional bridge adapter (bun, ./server) on KOBE_BRIDGE_PORT (5174)
 *   - the Vite dev server (node) on 5173, proxying /api + /events to it
 *
 * The bridge is a transitional process that talks to the daemon over the
 * socket protocol — it runs under `bun --watch`, so editing server/ code
 * hot-restarts it during migration. ADR 0003 moves the target web seam into
 * daemon-hosted local HTTP/SSE routes.
 * Ctrl-C tears everything down.
 *
 * Daemon isolation: `bun run dev` connects to whatever the default socket
 * points to — your PRODUCTION `~/.kobe` daemon. `bun run dev:sandbox` sets
 * `KOBE_HOME_DIR` to a throwaway home so the bridge, the PTY engines, and
 * tmux all use a sandbox and never touch production `tasks.json`. The banner
 * below always prints which home this session is wired to, so you can never
 * mistake one for the other. (Automated tests — `bun run test` — touch no
 * daemon at all; that isolation is unconditional.)
 */

import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

const BRIDGE_PORT = process.env.KOBE_BRIDGE_PORT ?? "5174"
const WEB_PORT = process.env.KOBE_WEB_PORT ?? "5173"
const PTY_PORT = process.env.KOBE_PTY_PORT ?? "5175"

// Resolve KOBE_HOME_DIR to an absolute path so every child agrees on the same
// home regardless of its cwd, and ensure it exists (the sandbox home may not
// yet). Unset → production `~/.kobe`.
const rawHome = process.env.KOBE_HOME_DIR
const homeDir = rawHome ? resolve(rawHome) : null
if (homeDir) mkdirSync(homeDir, { recursive: true })
const childEnv = { ...process.env, ...(homeDir ? { KOBE_HOME_DIR: homeDir } : {}) }

const sandboxed = homeDir !== null
console.log(
  `\x1b[1m[kobe web dev]\x1b[0m ${sandboxed ? "\x1b[33msandbox\x1b[0m" : "\x1b[31mPRODUCTION\x1b[0m"} · home: ${homeDir ?? `${homedir()}/.kobe (production)`}`,
)
console.log(
  `  web :${WEB_PORT}  bridge :${BRIDGE_PORT}  pty :${PTY_PORT}${process.env.KOBE_TMUX_SOCKET ? `  tmux: ${process.env.KOBE_TMUX_SOCKET}` : ""}`,
)

// bun: transitional bridge adapter (SSE/RPC/notes/diff/session) — target is daemon-hosted.
const bridge = Bun.spawn(["bun", "--watch", "server/main.ts"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...childEnv, KOBE_BRIDGE_PORT: BRIDGE_PORT },
})

// node: PTY terminal server — node-pty only works under node, not bun.
// Needs the bridge port to fetch each tab's engine launch spec.
const pty = Bun.spawn(["node", "pty-server.mjs"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...childEnv, KOBE_PTY_PORT: PTY_PORT, KOBE_BRIDGE_PORT: BRIDGE_PORT },
})

// node (via vite): the SPA, proxying /api + /events + /pty to the above.
const vite = Bun.spawn(["bun", "run", "vite", "dev", "--port", WEB_PORT, "--strictPort"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...childEnv, KOBE_BRIDGE_PORT: BRIDGE_PORT, KOBE_PTY_PORT: PTY_PORT },
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
