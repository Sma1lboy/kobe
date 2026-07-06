
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"

const DAEMON_WEB_PORT = process.env.KOBE_DAEMON_WEB_PORT ?? "5174"
const WEB_PORT = process.env.KOBE_WEB_PORT ?? "5173"
const PTY_PORT = process.env.KOBE_PTY_PORT ?? "5175"

const rawHome = process.env.KOBE_HOME_DIR
const homeDir = rawHome ? resolve(rawHome) : null
if (homeDir) mkdirSync(homeDir, { recursive: true })
if (homeDir) process.env.KOBE_HOME_DIR = homeDir
process.env.KOBE_DAEMON_WEB_PORT = DAEMON_WEB_PORT
const childEnv = { ...process.env, ...(homeDir ? { KOBE_HOME_DIR: homeDir } : {}) }

const sandboxed = homeDir !== null
console.log(
  `\x1b[1m[kobe web dev]\x1b[0m ${sandboxed ? "\x1b[33msandbox\x1b[0m" : "\x1b[31mPRODUCTION\x1b[0m"} · home: ${homeDir ?? `${homedir()}/.kobe (production)`}`,
)
console.log(
  `  web :${WEB_PORT}  daemon-web :${DAEMON_WEB_PORT}  pty :${PTY_PORT}${process.env.KOBE_TMUX_SOCKET ? `  tmux: ${process.env.KOBE_TMUX_SOCKET}` : ""}`,
)

await ensureDaemonReachable()
try {
  const res = await fetch(`http://127.0.0.1:${DAEMON_WEB_PORT}/__kobe_web`, {
    signal: AbortSignal.timeout(1500),
  })
  if ((await res.text()).trim() !== "kobe-web") throw new Error("unexpected health marker")
} catch (err) {
  throw new Error(
    `daemon web transport is not reachable on :${DAEMON_WEB_PORT}; run \`kobe daemon restart\` so the daemon picks up this build (${err instanceof Error ? err.message : String(err)})`,
  )
}

const pty = Bun.spawn(["node", "pty-server.mjs"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...childEnv, KOBE_PTY_PORT: PTY_PORT, KOBE_DAEMON_WEB_PORT: DAEMON_WEB_PORT },
})

const vite = Bun.spawn(["bun", "run", "vite", "dev", "--port", WEB_PORT, "--strictPort"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...childEnv, KOBE_DAEMON_WEB_PORT: DAEMON_WEB_PORT, KOBE_PTY_PORT: PTY_PORT },
})

const shutdown = (): void => {
  pty.kill()
  vite.kill()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("exit", shutdown)

void Promise.race([pty.exited, vite.exited]).then(() => {
  shutdown()
  process.exit(0)
})
