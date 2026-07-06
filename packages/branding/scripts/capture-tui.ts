#!/usr/bin/env bun

import { $ } from "bun"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const FPS = Number(arg("fps", "10"))
const SECONDS = Number(arg("seconds", "120"))
const OUT = arg("out", "src/quicklook/frames.json")
const REPO = arg("repo", "/Users/jacksonc/i/kobe")
const COLS = 160
const ROWS = 45

const SOCKET = "kobe-capture"
const SESSION = "quicklook"
const HOME = `${import.meta.dir}/../${arg("home", ".capture-home-5")}`

const KOBE_SRC = `${import.meta.dir}/../../kobe`
const BIN = `${HOME}/bin`
await $`mkdir -p ${BIN}`.quiet()
await Bun.write(
  `${BIN}/kobe`,
  `#!/bin/sh\nexec env KOBE_DEV=1 bun --preload ${KOBE_SRC}/node_modules/@opentui/solid/scripts/preload.ts --conditions=browser ${KOBE_SRC}/src/cli/index.ts "$@"\n`,
)
await $`chmod +x ${BIN}/kobe`.quiet()
const PATH = `${BIN}:${process.env.PATH}`

const ENV = {
  ...process.env,
  PATH,
  KOBE_HOME_DIR: HOME,
  KOBE_TMUX_SOCKET: "kobe-capture-inner",
}

const CLAUDE_PROMPT = "Explain what packages/kobe/src/cli/api-cmd.ts does in three short bullets. Read-only."
const CODEX_PROMPT = "Summarize the purpose of packages/branding in two sentences. Read-only."

const tmux = (...args: string[]) => $`tmux -L ${SOCKET} ${args}`.env(ENV).quiet()
const key = (k: string) => tmux("send-keys", "-t", SESSION, k)
const sleep = (ms: number) => Bun.sleep(ms)

async function killPanesThenServer(socket: string): Promise<void> {
  const out = await $`tmux -L ${socket} list-panes -a -F '#{pane_pid}'`.env(ENV).quiet().nothrow().text()
  for (const line of out.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 1) continue
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
      }
    }
  }
  await $`tmux -L ${socket} kill-server`.env(ENV).quiet().nothrow()
}

let torndown = false
async function teardown(): Promise<void> {
  if (torndown) return
  torndown = true
  await killPanesThenServer(SOCKET)
  await $`kobe daemon stop`.env(ENV).quiet().nothrow()
  await killPanesThenServer("kobe-capture-inner")
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void teardown().finally(() => process.exit(130))
  })
}
process.on("uncaughtException", (err) => {
  console.error("capture crashed:", err)
  void teardown().finally(() => process.exit(1))
})
process.on("unhandledRejection", (err) => {
  console.error("capture crashed (rejection):", err)
  void teardown().finally(() => process.exit(1))
})

async function typeText(text: string, msPerChar: number): Promise<void> {
  for (const ch of text) {
    await $`tmux -L ${SOCKET} send-keys -t ${SESSION} -l ${ch}`.env(ENV).quiet()
    await sleep(msPerChar)
  }
}

async function waitFor(re: RegExp, timeoutMs: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const text = await tmux("capture-pane", "-p", "-t", SESSION).text()
    if (re.test(text)) return
    await sleep(300)
  }
}

async function createTaskViaDialog(engine: "claude" | "codex"): Promise<void> {
  await key("n")
  await waitFor(/New task/, 8_000)
  await sleep(1500)
  if (engine === "codex") {
    await key("C-e")
    await sleep(900)
  }
  for (let i = 0; i < 4; i++) {
    await key("Tab")
    await sleep(700)
  }
  await key("Enter")
}

await $`mkdir -p ${HOME}`.quiet()
await tmux("kill-server").nothrow()

await $`kobe api add --repo ${REPO} --title ${"fix flaky turn-detector test"} --status in_progress`
  .env(ENV)
  .quiet()
  .nothrow()

await tmux(
  "new-session", "-d", "-s", "warmup", "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", "KOBE_TMUX_SOCKET=kobe-capture-inner",
  "-e", `PATH=${PATH}`,
  "-c", REPO,
  "kobe",
)
await sleep(50_000)
await tmux("kill-session", "-t", "warmup").nothrow()

await tmux(
  "new-session", "-d", "-s", SESSION, "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", "KOBE_TMUX_SOCKET=kobe-capture-inner",
  "-e", `PATH=${PATH}`, "-e", "PS1=jackson@kobe:~/i/kobe$ ",
  "-c", REPO,
  "sh",
)

const BEATS: Array<[number, () => Promise<unknown>]> = [
  [1.0, () => typeText("kobe", 160)],
  [2.2, () => key("Enter")],
  [7.0, () => key("C-h")],
  [8.0, () => createTaskViaDialog("claude")],
  [32.0, () => typeText(CLAUDE_PROMPT, 45).then(() => sleep(500)).then(() => key("Enter"))],
  [60.0, () => key("C-h")],
  [61.0, () => createTaskViaDialog("codex")],
  [86.0, async () => {
    await waitFor(/›/, 30_000)
    const screen = await tmux("capture-pane", "-p", "-t", SESSION).text()
    if (screen.includes("Hooks need review")) {
      await key("Down")
      await sleep(600)
      await key("Enter")
      await sleep(1500)
      await waitFor(/›/, 20_000)
    }
    await sleep(1200)
    await typeText(CODEX_PROMPT, 45)
    await sleep(500)
    await key("Enter")
  }],
]

const frames: Array<{ t: number; lines: string[] }> = []
let last = ""
const fired = new Set<number>()
const start = Date.now()
const elapsed = () => (Date.now() - start) / 1000

while (elapsed() < SECONDS) {
  const t = elapsed()
  for (let b = 0; b < BEATS.length; b++) {
    if (t >= BEATS[b][0] && !fired.has(b)) {
      fired.add(b)
      BEATS[b][1]().catch(() => {})
    }
  }
  const text = await tmux("capture-pane", "-ep", "-t", SESSION).text()
  if (text !== last) {
    last = text
    frames.push({ t: elapsed(), lines: text.replace(/\n$/, "").split("\n") })
  }
  await sleep(Math.max(0, 1000 / FPS - (elapsed() - t) * 1000))
}

await teardown()

await Bun.write(
  new URL(`../${OUT}`, import.meta.url),
  JSON.stringify({ cols: COLS, rows: ROWS, fps: FPS, seconds: SECONDS, frames }),
)
console.log(`captured ${frames.length} keyframes -> ${OUT}`)
