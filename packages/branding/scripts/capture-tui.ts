#!/usr/bin/env bun
// Capture a scripted kobe TUI session as ANSI keyframes for the Remotion
// quicklook composition. Runs the real TUI in an isolated tmux server +
// throwaway KOBE_HOME, polls `capture-pane -e` and stores changed frames.
//
// Usage: bun scripts/capture-tui.ts [--fps 10] [--seconds 8] [--out src/quicklook/frames.json]
//
// ponytail: keystroke script is inline below; move to a JSON scenario file
// when we need more than one demo.

import { $ } from "bun"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const FPS = Number(arg("fps", "10"))
const SECONDS = Number(arg("seconds", "8"))
const OUT = arg("out", "src/quicklook/frames.json")
const COLS = 160
const ROWS = 45

const SOCKET = "kobe-capture"
const SESSION = "quicklook"
const HOME = `${import.meta.dir}/../.capture-home`

const tmux = (...args: string[]) => $`tmux -L ${SOCKET} ${args}`.quiet()

// Scripted interaction: [atSecond, tmux send-keys args]
const SCRIPT: Array<[number, string[]]> = [
  [2, ["j"]],
  [3, ["j"]],
  [4, ["k"]],
]

await $`mkdir -p ${HOME}`.quiet()
await tmux("kill-server").nothrow()
await tmux(
  "new-session", "-d", "-s", SESSION, "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", "KOBE_TMUX_SOCKET=kobe-capture-inner",
  "kobe",
)

const frames: Array<{ t: number; lines: string[] }> = []
let last = ""
const total = Math.round(FPS * SECONDS)
const sent = new Set<number>()

for (let i = 0; i < total; i++) {
  const t = i / FPS
  for (const [at, keys] of SCRIPT) {
    if (t >= at && !sent.has(at)) {
      sent.add(at)
      await tmux("send-keys", "-t", SESSION, ...keys)
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

await Bun.write(
  new URL(`../${OUT}`, import.meta.url),
  JSON.stringify({ cols: COLS, rows: ROWS, fps: FPS, seconds: SECONDS, frames }),
)
console.log(`captured ${frames.length} keyframes -> ${OUT}`)
