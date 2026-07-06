import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

type Mode = "run" | "reset" | "home"

function parseMode(raw: string | undefined): Mode {
  if (raw === undefined || raw === "run") return "run"
  if (raw === "reset" || raw === "home") return raw
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

  const repoRoot = dirname(await gitCommonDir())
  return join(repoRoot, "packages", "kobe", ".dev-sandbox", "home")
}

const mode = parseMode(process.argv[2])
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
  KOBE_TMUX_SOCKET: process.env.KOBE_TMUX_SOCKET ?? "kobe-sandbox",
}

const args =
  mode === "reset"
    ? [process.execPath, "./src/cli/index.ts", "kill-sessions"]
    : [process.execPath, "--preload", "@opentui/solid/preload", "--conditions=browser", "./src/cli/index.ts"]

const child = Bun.spawn(args, {
  cwd: process.cwd(),
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
