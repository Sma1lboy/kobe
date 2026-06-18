/**
 * `kobe web` — launch the local web UI.
 *
 * Serves the kobe web dashboard through the daemon-hosted local HTTP/SSE
 * transport. Browser routes backed by daemon state come from the daemon
 * directly; this command only ensures the daemon is reachable and starts the
 * PTY sidecar.
 *
 *   kobe web                 serve the built SPA on :5174
 *   kobe web --port 5180     bind a different port
 *   kobe web --routes-only   start only the daemon web routes
 *   kobe web --no-takeover   fail instead of replacing a prior kobe-web
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"

const DAEMON_WEB_HEALTH_MARKER = "kobe-web"
const DAEMON_WEB_HEALTH_PATH = "/__kobe_web"

/** Which daemon home this `kobe web` is wired to — production `~/.kobe` unless
 *  KOBE_HOME_DIR points it elsewhere (a sandbox). Surfaced in the startup line
 *  so it's never a mystery which task index the dashboard is showing. */
function homeLabel(): string {
  const explicit = process.env.KOBE_HOME_DIR?.trim()
  return explicit ? `sandbox: ${explicit}` : `${homedir()}/.kobe (production)`
}

type PtyProcess = ReturnType<typeof Bun.spawn>

const USAGE = `Usage: kobe web [options]

Launch the kobe web UI through daemon web transport on http://localhost:<port>.

Options:
  --port <n>        Daemon web transport port (default 5174).
  --routes-only     Routes only; Vite serves the SPA separately.
  --no-takeover     Reserved for compatibility; daemon owns the web port.
  -h, --help        Show this help.
`

/**
 * Resolve the built SPA directory. Source checkouts can serve
 * packages/kobe-web/dist after a web build; packaged installs serve the copy
 * emitted into dist/web-ui by the kobe build.
 */
function resolveStaticDir(): string | undefined {
  const here = fileURLToPath(import.meta.url)
  const candidates = [
    resolve(here, "../../../../kobe-web/dist"), // dev: packages/kobe-web/dist
    resolve(here, "../../web-ui"), // packaged: dist/web-ui (copied at build)
  ]
  for (const dir of candidates) {
    if (existsSync(`${dir}/index.html`)) return dir
  }
  return undefined
}

function resolvePtyServer(): string | undefined {
  const here = fileURLToPath(import.meta.url)
  const candidates = [
    resolve(here, "../../../../kobe-web/pty-server.mjs"), // dev: packages/kobe-web/pty-server.mjs
    resolve(here, "../../web-ui/pty-server.mjs"), // packaged: dist/web-ui/pty-server.mjs
  ]
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return undefined
}

async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    return out
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid)
  } catch {
    return []
  }
}

async function takeoverPtyPort(port: number): Promise<void> {
  let body: string
  try {
    const res = await fetch(`http://localhost:${port}${DAEMON_WEB_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(800),
    })
    body = (await res.text()).trim()
  } catch {
    return
  }
  if (body !== DAEMON_WEB_HEALTH_MARKER) {
    throw new Error(`PTY port ${port} is in use by a non-kobe service; refusing to replace it`)
  }
  const pids = await pidsOnPort(port)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if ((await pidsOnPort(port)).length === 0) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function startPtyServer(opts: {
  webPort: number
  takeover: boolean
}): Promise<PtyProcess | null> {
  const script = resolvePtyServer()
  if (!script) return null
  const ptyPort = opts.webPort + 2
  if (opts.takeover) await takeoverPtyPort(ptyPort)
  return Bun.spawn(["node", script], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      KOBE_DAEMON_WEB_PORT: String(opts.webPort),
      KOBE_PTY_PORT: String(ptyPort),
    },
  })
}

async function ensureDaemonWeb(port: number, staticDir?: string): Promise<void> {
  process.env.KOBE_DAEMON_WEB_PORT = String(port)
  if (staticDir) process.env.KOBE_DAEMON_WEB_STATIC_DIR = staticDir
  await ensureDaemonReachable()
  let body: string
  try {
    const res = await fetch(`http://127.0.0.1:${port}${DAEMON_WEB_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(1500),
    })
    body = (await res.text()).trim()
  } catch (err) {
    throw new Error(
      `daemon web transport is not reachable on :${port}; run \`kobe daemon restart\` so the daemon picks up this build (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (body !== DAEMON_WEB_HEALTH_MARKER) {
    throw new Error(`unexpected daemon web health marker on :${port}: ${body}`)
  }
  if (staticDir) {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) {
      throw new Error(
        `daemon web transport is up on :${port} but is not serving web assets; run \`kobe daemon restart\` so it picks up ${staticDir}`,
      )
    }
  }
}

export async function runWebSubcommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return
  }

  let port = 5174
  const portIdx = args.indexOf("--port")
  if (portIdx !== -1) {
    const value = Number.parseInt(args[portIdx + 1] ?? "", 10)
    if (!Number.isFinite(value)) {
      process.stderr.write("kobe web: --port needs a number\n")
      process.exit(2)
    }
    port = value
  }

  try {
    const routesOnly = args.includes("--routes-only") || args.includes("--bridge-only")
    const takeover = !args.includes("--no-takeover")
    const staticDir = routesOnly ? undefined : resolveStaticDir()
    if (!routesOnly && !staticDir) {
      throw new Error(
        "web assets are missing from this kobe build; run `bun run build` in packages/kobe, or `bun run dev` in packages/kobe-web from a source checkout",
      )
    }
    await ensureDaemonWeb(port, staticDir)
    let pty: PtyProcess | null = null
    let stopped = false

    const stop = (): void => {
      if (stopped) return
      stopped = true
      pty?.kill()
      pty = null
    }

    if (routesOnly) {
      process.stdout.write(`kobe daemon web transport listening on http://localhost:${port} (routes only)\n`)
      process.stdout.write(`  home: ${homeLabel()}\n`)
    } else {
      pty = await startPtyServer({ webPort: port, takeover })
      process.stdout.write(`kobe web → http://localhost:${port}\n`)
      process.stdout.write(`  home: ${homeLabel()}\n`)
      if (!pty) {
        process.stderr.write("kobe web: PTY server not found; terminal tabs will be unavailable\n")
      }
    }

    process.on("SIGINT", () => {
      stop()
      process.exit(0)
    })
    process.on("SIGTERM", () => {
      stop()
      process.exit(0)
    })
    void pty?.exited.then(() => {
      if (!stopped) {
        process.stderr.write("kobe web: PTY server exited\n")
        stop()
        process.exit(1)
      }
    })
    await new Promise<void>(() => {})
  } catch (err) {
    process.stderr.write(`kobe web: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
