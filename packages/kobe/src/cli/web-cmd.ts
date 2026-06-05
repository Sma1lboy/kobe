/**
 * `kobe web` — launch the local web UI (Wave A).
 *
 * Serves the kobe web dashboard on http://localhost:<port> (default 5173),
 * by asking the kobe daemon to expose its web transport. If a prior kobe-web
 * already holds the port it is replaced; a foreign service on the port is
 * reported, not killed.
 *
 *   kobe web                 serve the built SPA via daemon web on :5173
 *   kobe web --port 5180     bind a different port
 *   kobe web --bridge-only   daemon web routes only (Vite serves the SPA in dev)
 *   kobe web --no-takeover   fail instead of replacing a prior kobe-web
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { WEB_HEALTH_MARKER, WEB_HEALTH_PATH } from "@sma1lboy/kobe-daemon/daemon/web"

type PtyProcess = ReturnType<typeof Bun.spawn>

const USAGE = `Usage: kobe web [options]

Launch the kobe web UI on http://localhost:<port>.

Options:
  --port <n>        Port to bind (default 5173).
  --bridge-only     Serve only daemon web routes (/events, /api/rpc);
                    Vite serves the SPA separately in dev.
  --no-takeover     Fail if the port is busy instead of replacing a prior
                    kobe-web instance.
  -h, --help        Show this help.
`

/**
 * Resolve the built SPA directory shipped with the kobe package. In dev
 * (source tree) the web app lives at ../../kobe-web/dist; once packaged the
 * build step copies it next to dist. Returns undefined if not found so the
 * server falls back to a "not built" message rather than crashing.
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
    const res = await fetch(`http://localhost:${port}${WEB_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(800),
    })
    body = (await res.text()).trim()
  } catch {
    return
  }
  if (body !== WEB_HEALTH_MARKER) {
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
      KOBE_BRIDGE_PORT: String(opts.webPort),
      KOBE_PTY_PORT: String(ptyPort),
    },
  })
}

export async function runWebSubcommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return
  }

  let port = 5173
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
    const bridgeOnly = args.includes("--bridge-only")
    const takeover = !args.includes("--no-takeover")
    const client = await connectOrStartDaemon()
    let pty: PtyProcess | null = null
    let stopped = false

    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      pty?.kill()
      pty = null
      try {
        await client.request("daemon.web.stop")
      } catch {
        /* daemon may already be gone */
      }
      client.close()
    }

    const { port: bound } = await client.request<{ port: number }>("daemon.web.start", {
      port,
      takeover,
      staticDir: bridgeOnly ? undefined : resolveStaticDir(),
    })
    if (bridgeOnly) {
      process.stdout.write(`kobe daemon web listening on http://localhost:${bound} (routes only)\n`)
    } else {
      pty = await startPtyServer({ webPort: bound, takeover })
      process.stdout.write(`kobe web → http://localhost:${bound}\n`)
      if (!pty) {
        process.stderr.write("kobe web: PTY server not found; terminal tabs will be unavailable\n")
      }
    }

    process.on("SIGINT", () => {
      void stop().finally(() => process.exit(0))
    })
    process.on("SIGTERM", () => {
      void stop().finally(() => process.exit(0))
    })
    void pty?.exited.then(() => {
      if (!stopped) {
        process.stderr.write("kobe web: PTY server exited\n")
        void stop().finally(() => process.exit(1))
      }
    })
    await new Promise<void>(() => {})
  } catch (err) {
    process.stderr.write(`kobe web: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
