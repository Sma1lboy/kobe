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
    let stopped = false

    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
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
      process.stdout.write(`kobe web → http://localhost:${bound}\n`)
    }

    process.on("SIGINT", () => {
      void stop().finally(() => process.exit(0))
    })
    process.on("SIGTERM", () => {
      void stop().finally(() => process.exit(0))
    })
    await new Promise<void>(() => {})
  } catch (err) {
    process.stderr.write(`kobe web: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
