import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { readRoveEnv } from "@sma1lboy/kobe-daemon/compat-env"
import { stopDaemonProcess } from "@sma1lboy/kobe-daemon/daemon/lifecycle"
import {
  defaultDaemonPidPath,
  defaultDaemonSocketPath,
  defaultPtyHostPidPath,
  defaultPtyHostSocketPath,
} from "@sma1lboy/kobe-daemon/daemon/paths"
import { parseSandboxArgs, sandboxChildEnv } from "./dev-sandbox-args.ts"

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
  const explicit = readRoveEnv("SANDBOX_HOME_DIR")?.trim()
  if (explicit) return explicit

  // Share one dev sandbox across git worktrees. `git-common-dir` points at
  // the primary checkout's `.git`, even when this script runs from a Rove
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
console.error(`[rove dev:sandbox] home: ${home}`)

// Isolate the sandbox daemon's home and web port from production. Both env
// namespaces are stamped so a child wrapper cannot revive an ambient value.
const env = sandboxChildEnv(home)

if (mode === "reset") {
  await stopDaemonProcess(defaultDaemonSocketPath(home), defaultDaemonPidPath(home))
  await stopDaemonProcess(defaultPtyHostSocketPath(home), defaultPtyHostPidPath(home))
  console.error("[rove dev:sandbox] stopped daemon and PTY host")
  process.exit(0)
}

const args = [process.execPath, "--conditions=browser", "./src/cli/rove.ts"]

const child = Bun.spawn(args, {
  cwd: process.cwd(),
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
