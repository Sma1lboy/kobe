import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultDaemonSocketPath } from "../daemon/paths.ts"
import { KobeDaemonClient } from "./index.ts"

export async function connectOrStartDaemon(): Promise<KobeDaemonClient> {
  const socketPath = defaultDaemonSocketPath()
  const client = new KobeDaemonClient(socketPath)
  if (await canConnect(client)) return client

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
    const next = new KobeDaemonClient(socketPath)
    try {
      await next.connect()
      return next
    } catch (err) {
      lastErr = err
      next.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `kobe: daemon did not start at ${socketPath}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

async function canConnect(client: KobeDaemonClient): Promise<boolean> {
  try {
    await client.connect()
    return true
  } catch {
    client.close()
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
