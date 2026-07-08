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
import replaySpecJson from "../src/quicklook/quicklook.replay.json"
import { resolveReplaySpec, type ReplayBeat, type ReplayStep } from "../src/quicklook/replay-spec"

const spec = resolveReplaySpec(replaySpecJson, {
  cols: replaySpecJson.viewport.cols,
  rows: replaySpecJson.viewport.rows,
  frames: [{ t: replaySpecJson.capture.seconds, lines: [] }],
})

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const FPS = Number(arg("fps", String(spec.capture.fps)))
const SECONDS = Number(arg("seconds", String(spec.capture.seconds)))
const OUT = arg("out", spec.capture.output)
const REPO = arg("repo", spec.capture.repoDefault)
const COLS = spec.viewport.cols
const ROWS = spec.viewport.rows

const SOCKET = spec.capture.socket ?? `${spec.id}-capture`
const INNER_SOCKET = spec.capture.innerSocket ?? `${SOCKET}-inner`
const SESSION = spec.capture.session ?? spec.id
const homeArg = arg("home", spec.capture.home)
const HOME = homeArg.startsWith("/") ? homeArg : `${import.meta.dir}/../${homeArg}`

// The demo must run the LOCAL source (dev:sandbox flavour), not the installed
// CLI — a shim named `kobe` first in PATH keeps the on-camera command spelled
// `kobe` while executing this repo's packages/kobe.
const KOBE_SRC = `${import.meta.dir}/../../kobe`
const BIN = `${HOME}/bin`
await $`mkdir -p ${BIN}`.quiet()
// Preload by absolute path — a relative path resolves from the
// *invocation* cwd (the repo on camera), where it doesn't exist. kobe's
// own preload (scripts/jsx-plugin.ts) replaces the bare
// @opentui/solid/preload: Solid transform everywhere EXCEPT
// src/tui-react/** (React pragma files), matching kobe's dev scripts.
const PRELOAD = `${KOBE_SRC}/scripts/jsx-preload.ts`
await Bun.write(
  `${BIN}/kobe`,
  `#!/bin/sh\nexec env KOBE_DEV=1 bun --preload ${PRELOAD} --conditions=browser ${KOBE_SRC}/src/cli/index.ts "$@"\n`,
)
await $`chmod +x ${BIN}/kobe`.quiet()
const PATH = `${BIN}:${process.env.PATH}`

const ENV = {
  ...process.env,
  PATH,
  KOBE_HOME_DIR: HOME,
  KOBE_TMUX_SOCKET: INNER_SOCKET,
}

const tmux = (...args: string[]) => $`tmux -L ${SOCKET} ${args}`.env(ENV).quiet()
const key = (k: string) => tmux("send-keys", "-t", SESSION, k)
const sleep = (ms: number) => Bun.sleep(ms)
const screenText = () => tmux("capture-pane", "-p", "-t", SESSION).text()

/**
 * Kill a socket's pane PROCESSES, then its server. `kill-server` alone only
 * SIGHUPs the panes, and the opentui pane hosts survive SIGHUP — they reparent
 * to init and keep polling forever (the observed leak: 16 orphaned `kobe
 * tasks/ops` processes from dead capture sockets). SIGKILL each pane's process
 * group first so nothing outlives the capture.
 */
async function killPanesThenServer(socket: string): Promise<void> {
  const out = await $`tmux -L ${socket} list-panes -a -F '#{pane_pid}'`.env(ENV).quiet().nothrow().text()
  for (const line of out.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 1) continue
    try {
      process.kill(-pid, "SIGKILL") // pane's process group
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
  }
  await $`tmux -L ${socket} kill-server`.env(ENV).quiet().nothrow()
}

/**
 * Idempotent full teardown — outer capture server, sandbox daemon, inner kobe
 * server. Wired to normal exit AND crash/interrupt paths below: a capture that
 * dies mid-run must never leave engine/pane processes behind (leaks are bugs).
 */
let torndown = false
async function teardown(): Promise<void> {
  if (torndown) return
  torndown = true
  await killPanesThenServer(SOCKET)
  await $`kobe daemon stop`.env(ENV).quiet().nothrow()
  await killPanesThenServer(INNER_SOCKET)
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

// Engine boot time jitters run to run — typing at a fixed time raced the
// boot and dropped leading chars. Poll until the screen shows `re` (the
// composer's placeholder), then it is safe to type.
async function waitFor(re: RegExp, timeoutMs: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const text = await screenText()
    if (re.test(text)) return
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${re}`)
}

async function waitForNamed(name: string): Promise<void> {
  const wait = spec.waits[name]
  if (!wait) throw new Error(`unknown replay wait "${name}"`)
  await waitFor(new RegExp(wait.pattern), wait.timeoutMs)
}

// Walk the NewTaskDialog. Wait for it to actually open (opening while the
// UI is busy ate a timed keypress once and the walk derailed into the wrong
// sub-tab), pick the engine with Ctrl+E (works from ANY field — no bet on
// where focus is), then Tab through tabs -> engine -> repo -> branch ->
// Create and commit with Enter (only fires on the confirm field).
async function createTaskViaDialog(engine: string): Promise<void> {
  const flow = spec.flows?.createTask
  if (!flow) throw new Error('missing replay flow "createTask"')
  await key(flow.openKey ?? "n")
  await waitForNamed(flow.dialogWait)
  await sleep(flow.dialogSettleMs ?? 1500) // dialog just opened, let it breathe on camera
  if (engine === "codex" && flow.codexEngineCycleKey) {
    await key(flow.codexEngineCycleKey) // cycle engine vendor
    await sleep(flow.codexEngineSettleMs ?? 900)
  }
  for (let i = 0; i < (flow.tabCount ?? 4); i++) {
    await key("Tab")
    await sleep(flow.tabDelayMs ?? 700)
  }
  await key(flow.submitKey ?? "Enter") // [ Create ]
}

function textForBeat(beat: ReplayBeat): string {
  if (typeof beat.text === "string") return beat.text
  if (beat.textRef && spec.text[beat.textRef]) return spec.text[beat.textRef]
  throw new Error(`replay beat at ${beat.at}s is missing text/textRef`)
}

async function typeAndMaybeSubmit(beat: ReplayBeat): Promise<void> {
  await typeText(textForBeat(beat), beat.msPerChar ?? 45)
  if (beat.submit) {
    await sleep(beat.submitDelayMs ?? 500)
    await key("Enter")
  }
}

async function runStep(step: ReplayStep): Promise<void> {
  if (step.action === "key") await key(step.key)
  else if (step.action === "sleep") await sleep(step.ms)
  else await waitForNamed(step.waitFor)
}

async function runBeat(beat: ReplayBeat): Promise<void> {
  switch (beat.action) {
    case "typeText":
      await typeAndMaybeSubmit(beat)
      return
    case "typeTextWhenReady":
      if (!beat.waitFor) throw new Error(`replay beat at ${beat.at}s is missing waitFor`)
      await waitForNamed(beat.waitFor)
      for (const rule of beat.dismissIfText ?? []) {
        const screen = await screenText()
        if (screen.includes(rule.includes)) for (const step of rule.steps) await runStep(step)
      }
      if (beat.settleMs) await sleep(beat.settleMs)
      await typeAndMaybeSubmit(beat)
      return
    case "key":
      if (!beat.key) throw new Error(`replay beat at ${beat.at}s is missing key`)
      await key(beat.key)
      return
    case "flow":
      if (beat.flow === "createTask") {
        await createTaskViaDialog(beat.engine ?? "claude")
        return
      }
      throw new Error(`unknown replay flow "${beat.flow}"`)
    case "sleep":
      await sleep(beat.ms ?? 0)
      return
  }
}

await $`mkdir -p ${HOME}`.quiet()
await tmux("kill-server").nothrow()

// Pre-existing tasks so the sidebar isn't empty (no engine, just the row).
for (const task of spec.setup?.seedTasks ?? []) {
  await $`kobe api add --repo ${REPO} --title ${task.title} --status ${task.status}`
    .env(ENV)
    .quiet()
    .nothrow()
}

// Warm-up pass (off camera): boot the TUI once so the pre-seeded task's
// worktree + bun install settle before we roll — the video must open on a
// calm kobe workspace, not an install screen.
await tmux(
  "new-session", "-d", "-s", "warmup", "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", `KOBE_TMUX_SOCKET=${INNER_SOCKET}`,
  "-e", `PATH=${PATH}`,
  "-c", REPO,
  "kobe",
)
await sleep((spec.capture.warmupSeconds ?? 50) * 1000)
await tmux("kill-session", "-t", "warmup").nothrow()

// Plain shell first — the demo opens on `$ kobe<Enter>` like the original.
await tmux(
  "new-session", "-d", "-s", SESSION, "-x", String(COLS), "-y", String(ROWS),
  "-e", `KOBE_HOME_DIR=${HOME}`, "-e", `KOBE_TMUX_SOCKET=${INNER_SOCKET}`,
  "-e", `PATH=${PATH}`, "-e", `PS1=${spec.capture.shellPrompt}`,
  "-c", REPO,
  "sh",
)

// Scripted beats: [atSecond, action]. Long-running beats sleep internally;
// the capture loop keeps polling concurrently.
const BEATS = spec.beats

const frames: Array<{ t: number; lines: string[] }> = []
let last = ""
const fired = new Set<number>()
const start = Date.now()
const elapsed = () => (Date.now() - start) / 1000

while (elapsed() < SECONDS) {
  const t = elapsed()
  for (let b = 0; b < BEATS.length; b++) {
    if (t >= BEATS[b].at && !fired.has(b)) {
      fired.add(b)
      // Bun Shell promises are lazy — .catch() forces execution without
      // stalling the capture loop on slow beats.
      runBeat(BEATS[b]).catch((error) => console.error(`replay beat ${b} failed:`, error))
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
