import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stopDaemonProcess } from "@sma1lboy/kobe-daemon/daemon/lifecycle"
import {
  defaultDaemonPidPath,
  defaultDaemonSocketPath,
  defaultPtyHostPidPath,
  defaultPtyHostSocketPath,
} from "@sma1lboy/kobe-daemon/daemon/paths"
import { parseSandboxArgs } from "./dev-sandbox-args.ts"

function usageError(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err))
  console.error("usage: bun run scripts/dev-sandbox.ts [run|reset|home]")
  process.exit(2)
}

async function gitCommonDir(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) process.exit(code)
  return stdout.trim()
}

async function sandboxHome(): Promise<string> {
  const explicit = process.env.KOBE_SANDBOX_HOME_DIR?.trim()
  if (explicit) return explicit

  // Share one dev sandbox across git worktrees. `git-common-dir` points at
  // the primary checkout's `.git`, even when this script runs from a Kobe
  // task worktree, so every sandbox run sees the same task store.
  const repoRoot = dirname(await gitCommonDir())
  return join(repoRoot, "packages", "kobe", ".dev-sandbox", "home")
}

let parsed: ReturnType<typeof parseSandboxArgs>
try {
  parsed = parseSandboxArgs(process.argv.slice(2))
} catch (err) {
  usageError(err)
}
const { mode } = parsed
const home = await sandboxHome()

if (mode === "home") {
  console.log(home)
  process.exit(0)
}

await mkdir(home, { recursive: true })
console.error(`[kobe dev:sandbox] home: ${home}`)

const env = {
  ...process.env,
  KOBE_DEV: "1",
  KOBE_HOME_DIR: home,
  // Isolate the sandbox daemon's web port from the production daemon's 5174 —
  // otherwise starting dev:sandbox races the real daemon for the same port.
  KOBE_DAEMON_WEB_PORT: process.env.KOBE_DAEMON_WEB_PORT ?? "5274",
}

if (mode === "reset") {
  await stopDaemonProcess(defaultDaemonSocketPath(home), defaultDaemonPidPath(home))
  await stopDaemonProcess(defaultPtyHostSocketPath(home), defaultPtyHostPidPath(home))
  console.error("[kobe dev:sandbox] stopped daemon and PTY host")
  process.exit(0)
}

const args = [process.execPath, "--conditions=browser", "./src/cli/index.ts"]

const child = Bun.spawn(args, {
  cwd: process.cwd(),
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
