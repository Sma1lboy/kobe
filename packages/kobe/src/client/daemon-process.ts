import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultDaemonSocketPath } from "../daemon/paths.ts"
import { KobeDaemonClient } from "./index.ts"

/**
 * If the daemon socket already accepts connections, do nothing. Otherwise
 * spawn a detached `kobed start` and poll until the socket is reachable
 * (5s deadline). Both the TUI startup path and the in-session "Restart
 * daemon" prompt share this so the spawn+poll loop lives in exactly one
 * place.
 *
 * Returns the resolved socket path so the caller can build a client
 * pointed at it. Throws if the daemon never comes up within the deadline.
 */
export async function ensureDaemonReachable(): Promise<string> {
  const socketPath = defaultDaemonSocketPath()
  if (await testCanConnect(socketPath)) return socketPath

  const { entry, runWithBun } = resolveKobedEntry()
  const child = runWithBun
    ? spawn(process.execPath, [entry, "start"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      })
    : spawn(entry, ["start"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      })
  child.unref()

  const deadline = Date.now() + 5000
  let lastErr: unknown
  while (Date.now() < deadline) {
    if (await testCanConnect(socketPath)) return socketPath
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(
    `kobe: daemon did not start at ${socketPath}: ${lastErr instanceof Error ? lastErr.message : "timeout"}`,
  )
}

export async function connectOrStartDaemon(): Promise<KobeDaemonClient> {
  const socketPath = await ensureDaemonReachable()
  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  return client
}

async function testCanConnect(socketPath: string): Promise<boolean> {
  const probe = new KobeDaemonClient(socketPath)
  try {
    await probe.connect()
    probe.close()
    return true
  } catch {
    probe.close()
    return false
  }
}

/**
 * Where to find `kobed`, expressed as either a JS entry to feed back to
 * `process.execPath` (the bun runtime) or a standalone executable to
 * spawn directly.
 *
 * Three layouts are possible:
 *  - dev: running from source via `bun src/cli/index.ts`. `import.meta.url`
 *    points into `src/`, so we resolve the sibling `src/bin/kobed.ts`.
 *  - npm package: running the bundled `dist/cli/index.js`. The sibling
 *    `dist/bin/kobed.js` is what we want.
 *  - standalone: running a `bun build --compile` binary.
 *    `import.meta.url` lives inside the embedded VFS (`/$bunfs` on
 *    posix, `B:\~BUN` on Windows), so neither source nor dist exist on
 *    the user's filesystem. Spawn the sibling `kobed` executable next
 *    to `process.execPath` instead.
 */
function resolveKobedEntry(): { entry: string; runWithBun: boolean } {
  const here = fileURLToPath(import.meta.url)
  if (here.startsWith("/$bunfs") || here.startsWith("B:\\~BUN")) {
    const exeDir = dirname(process.execPath)
    const ext = process.platform === "win32" ? ".exe" : ""
    const sibling = join(exeDir, `kobed${ext}`)
    if (!existsSync(sibling)) {
      throw new Error(
        `kobe: standalone build expected sibling kobed binary at ${sibling}; extract the full release tarball.`,
      )
    }
    return { entry: sibling, runWithBun: false }
  }
  const dir = dirname(here)
  const sourceEntry = resolve(dir, "../bin/kobed.ts")
  if (existsSync(sourceEntry)) return { entry: sourceEntry, runWithBun: true }
  // here = .../dist/cli/index.js, so kobed.js sits at ../bin/ relative to it.
  // Using argv[1]'s dirname (the old path) double-counted /cli and produced
  // .../dist/cli/bin/kobed.js, which doesn't exist; spawn then failed silently
  // (stdio:"ignore") and the connect loop reported only "daemon did not start".
  const distEntry = resolve(dir, "../bin/kobed.js")
  if (existsSync(distEntry)) return { entry: distEntry, runWithBun: true }
  throw new Error(`kobe: could not locate kobed entry near ${dir}; expected ../bin/kobed.{ts,js}`)
}
