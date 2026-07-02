#!/usr/bin/env bun
// Capture a scripted kobe TUI demo as ANSI keyframes for the Remotion
// quicklook composition. Replays the original quicklook.mp4 storyboard:
// shell -> type `kobe` -> workspace -> create a real task (engine starts,
// agent works with tool calls) -> capture throughout.
//
// Runs the real TUI in an isolated tmux server + throwaway KOBE_HOME, polls
// `capture-pane -e` and stores changed frames.
//
// Usage: bun scripts/capture-tui.ts [--fps 10] [--seconds 75] [--out src/quicklook/frames.json]
//
// Side effect: creates one kobe task (branch kobe/<slug>-<id>) in --repo.

import { $ } from "bun"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const FPS = Number(arg("fps", "10"))
const SECONDS = Number(arg("seconds", "100"))
const OUT = arg("out", "src/quicklook/frames.json")
const REPO = arg("repo", "/Users/jacksonc/i/kobe")
const COLS = 160
const ROWS = 45

const SOCKET = "kobe-capture"
const SESSION = "quicklook"
const HOME = `${import.meta.dir}/../${arg("home", ".capture-home-2")}`
const ENV = {
  ...process.env,
  KOBE_HOME_DIR: HOME,
  KOBE_TMUX_SOCKET: "kobe-capture-inner",
}

const PROMPT =
  "Explain in three bullet points what packages/kobe/src/cli/api-cmd.ts does and how its verb groups are organized. Read-only: do not change any files."

const tmux = (...args: string[]) => $`tmux -L ${SOCKET} ${args}`.env(ENV).quiet()

let taskId = ""

await $`mkdir -p ${HOME}`.quiet()
await tmux("kill-server").nothrow()
// Plain shell first — the demo opens on `$ kobe<Enter>` like the original video.
await tmux(
  "new-session", "-d", "-s", SESSION, "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", "KOBE_TMUX_SOCKET=kobe-capture-inner",
  "-e", `PATH=${process.env.PATH}`, "-e", "PS1=jackson@kobe:~/i/kobe$ ",
  "-c", REPO,
  "sh",
)

// Scripted beats: [atSecond, action]
const BEATS: Array<[number, () => Promise<unknown>]> = [
  [1.0, () => tmux("send-keys", "-t", SESSION, "k")],
  [1.2, () => tmux("send-keys", "-t", SESSION, "o")],
  [1.4, () => tmux("send-keys", "-t", SESSION, "b")],
  [1.6, () => tmux("send-keys", "-t", SESSION, "e")],
  [2.0, () => tmux("send-keys", "-t", SESSION, "Enter")],
  [
    8.0,
    async () => {
      const out = await $`kobe api add --repo ${REPO} --vendor claude --title ${"explain kobe api cli"}`
        .env(ENV)
        .nothrow()
        .json()
        .catch(() => null)
      taskId = out?.task?.id ?? out?.id ?? ""
    },
  ],
  // Focus sidebar and walk selection onto the new task; `enter` opens it in
  // the workspace + builds the engine session (Sidebar.tsx / task-enter.ts).
  [11.0, () => tmux("send-keys", "-t", SESSION, "C-h")],
  [12.0, () => tmux("send-keys", "-t", SESSION, "j")],
  [13.0, () => tmux("send-keys", "-t", SESSION, "j")],
  [14.0, () => tmux("send-keys", "-t", SESSION, "Enter")],
  // Once the engine is up on-camera, paste the demo prompt into it.
  [
    26.0,
    () =>
      (taskId
        ? $`kobe api send --task-id ${taskId} --prompt ${PROMPT}`
        : $`kobe api send --prompt ${PROMPT}`
      )
        .env(ENV)
        .quiet()
        .nothrow(),
  ],
]

const frames: Array<{ t: number; lines: string[] }> = []
let last = ""
const total = Math.round(FPS * SECONDS)
const fired = new Set<number>()

for (let i = 0; i < total; i++) {
  const t = i / FPS
  for (let b = 0; b < BEATS.length; b++) {
    if (t >= BEATS[b][0] && !fired.has(b)) {
      fired.add(b)
      // Bun Shell promises are lazy — .catch() forces execution without
      // stalling the capture loop on slow beats (task creation).
      BEATS[b][1]().catch(() => {})
    }
  }
  const text = await tmux("capture-pane", "-ep", "-t", SESSION).text()
  if (text !== last) {
    last = text
    frames.push({ t, lines: text.replace(/\n$/, "").split("\n") })
  }
  await Bun.sleep(1000 / FPS)
}

await tmux("kill-server").nothrow()
// Stop the sandbox daemon + the engine session living on the inner socket.
await $`kobe daemon stop`.env(ENV).quiet().nothrow()
await $`tmux -L kobe-capture-inner kill-server`.env(ENV).quiet().nothrow()

await Bun.write(
  new URL(`../${OUT}`, import.meta.url),
  JSON.stringify({ cols: COLS, rows: ROWS, fps: FPS, seconds: SECONDS, frames }),
)
console.log(`captured ${frames.length} keyframes -> ${OUT}`)
