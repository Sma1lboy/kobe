#!/usr/bin/env bun
// Capture a scripted kobe TUI demo as ANSI keyframes for the Remotion
// quicklook composition. Storyboard mirrors the original quicklook.mp4:
//   shell types `kobe` -> workspace with a pre-existing task -> NewTaskDialog
//   (claude) -> engine boots on camera -> prompt typed char-by-char ->
//   agent tool stream -> second NewTaskDialog (codex) -> codex boots.
//
// Runs the real TUI in an isolated tmux server + throwaway KOBE_HOME, polls
// `capture-pane -e` and stores changed frames with wall-clock timestamps
// (so spinners and typing replay at true speed).
//
// Usage: bun scripts/capture-tui.ts [--home .capture-home-5] [--seconds 120]
// Side effect: creates kobe task branches in --repo (one per created task).

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

// The demo must run the LOCAL source (dev:sandbox flavour), not the installed
// CLI — a shim named `kobe` first in PATH keeps the on-camera command spelled
// `kobe` while executing this repo's packages/kobe.
const KOBE_SRC = `${import.meta.dir}/../../kobe`
const BIN = `${HOME}/bin`
await $`mkdir -p ${BIN}`.quiet()
await Bun.write(
  `${BIN}/kobe`,
  // Preload by absolute path — bare "@opentui/solid/preload" resolves from
  // the *invocation* cwd (the repo on camera), where it doesn't exist.
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

async function typeText(text: string, msPerChar: number): Promise<void> {
  for (const ch of text) {
    await $`tmux -L ${SOCKET} send-keys -t ${SESSION} -l ${ch}`.env(ENV).quiet()
    await sleep(msPerChar)
  }
}

// Engine boot time jitters run to run — typing at a fixed time raced the
// boot and dropped leading chars. Poll until the screen shows `re` (the
// composer's placeholder), then it is safe to type.
async function waitFor(re: RegExp, timeoutMs: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const text = await tmux("capture-pane", "-p", "-t", SESSION).text()
    if (re.test(text)) return
    await sleep(300)
  }
}

// Walk the NewTaskDialog. Wait for it to actually open (opening while the
// UI is busy ate a timed keypress once and the walk derailed into the wrong
// sub-tab), pick the engine with Ctrl+E (works from ANY field — no bet on
// where focus is), then Tab through tabs -> engine -> repo -> branch ->
// Create and commit with Enter (only fires on the confirm field).
async function createTaskViaDialog(engine: "claude" | "codex"): Promise<void> {
  await key("n")
  await waitFor(/New task/, 8_000)
  await sleep(1500) // dialog just opened, let it breathe on camera
  if (engine === "codex") {
    await key("C-e") // cycle engine vendor
    await sleep(900)
  }
  for (let i = 0; i < 4; i++) {
    await key("Tab")
    await sleep(700)
  }
  await key("Enter") // [ Create ]
}

await $`mkdir -p ${HOME}`.quiet()
await tmux("kill-server").nothrow()

// Pre-existing task so the sidebar isn't empty (no engine, just the row).
await $`kobe api add --repo ${REPO} --title ${"fix flaky turn-detector test"} --status in_progress`
  .env(ENV)
  .quiet()
  .nothrow()

// Warm-up pass (off camera): boot the TUI once so the pre-seeded task's
// worktree + bun install settle before we roll — the video must open on a
// calm kobe workspace, not an install screen.
await tmux(
  "new-session", "-d", "-s", "warmup", "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", "KOBE_TMUX_SOCKET=kobe-capture-inner",
  "-e", `PATH=${PATH}`,
  "-c", REPO,
  "kobe",
)
await sleep(50_000)
await tmux("kill-session", "-t", "warmup").nothrow()

// Plain shell first — the demo opens on `$ kobe<Enter>` like the original.
await tmux(
  "new-session", "-d", "-s", SESSION, "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", "KOBE_TMUX_SOCKET=kobe-capture-inner",
  "-e", `PATH=${PATH}`, "-e", "PS1=jackson@kobe:~/i/kobe$ ",
  "-c", REPO,
  "sh",
)

// Scripted beats: [atSecond, action]. Long-running beats sleep internally;
// the capture loop keeps polling concurrently.
const BEATS: Array<[number, () => Promise<unknown>]> = [
  [1.0, () => typeText("kobe", 160)],
  [2.2, () => key("Enter")],
  [7.0, () => key("C-h")], // sidebar focus
  [8.0, () => createTaskViaDialog("claude")], // via the real NewTaskDialog
  // Engine boots ~14-30s (worktree + bun install + claude). Then type the
  // first prompt into the composer, visibly.
  // Type, then submit — chained, not a separate timed beat: per-char send-keys
  // overhead makes typing finish later than nominal, and a timed Enter can
  // fire mid-prompt and submit a truncated message (it did).
  [32.0, () => typeText(CLAUDE_PROMPT, 45).then(() => sleep(500)).then(() => key("Enter"))],
  // Let the agent stream tool calls + response breathe (~20s on camera),
  // then create the codex task.
  [60.0, () => key("C-h")],
  [61.0, () => createTaskViaDialog("codex")],
  // NB: codex rotates its placeholder examples — never match their wording.
  // The composer prompt char "›" (U+203A) is codex-only (claude uses ❯,
  // the file tree uses ▸) and appears exactly when the composer is ready.
  [86.0, async () => {
    await waitFor(/›/, 30_000)
    // Codex may interpose a hooks-trust prompt whose list cursor is ALSO
    // "›" — typing into it derails the demo. Dismiss with "Trust all and
    // continue" (option 2), then wait for the real composer.
    const screen = await tmux("capture-pane", "-p", "-t", SESSION).text()
    if (screen.includes("Hooks need review")) {
      await key("Down")
      await sleep(600)
      await key("Enter")
      await sleep(1500)
      await waitFor(/›/, 20_000)
    }
    await sleep(1200) // composer just appeared — let it sit a beat
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
      // Bun Shell promises are lazy — .catch() forces execution without
      // stalling the capture loop on slow beats.
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

await tmux("kill-server").nothrow()
// Stop the sandbox daemon + engine sessions on the inner socket.
await $`kobe daemon stop`.env(ENV).quiet().nothrow()
await $`tmux -L kobe-capture-inner kill-server`.env(ENV).quiet().nothrow()

await Bun.write(
  new URL(`../${OUT}`, import.meta.url),
  JSON.stringify({ cols: COLS, rows: ROWS, fps: FPS, seconds: SECONDS, frames }),
)
console.log(`captured ${frames.length} keyframes -> ${OUT}`)
