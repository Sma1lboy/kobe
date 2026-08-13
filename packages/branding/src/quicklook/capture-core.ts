import { rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { CaptureFrame, CaptureLine, ResolvedReplaySpec } from "./replay-spec"

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const REDACTED = "you@example.com"
// CSI / OSC / two-byte escapes, in the order they must be tried.
const ANSI_TOKEN = new RegExp(`\u001b\\[[0-9;?]*[A-Za-z]|\u001b\\][^\u001b\u0007]*(?:\u0007|\u001b\\\\)|\u001b.`, "g")

/**
 * Blank the account identity Claude Code prints in its welcome box ("<email>'s
 * Organization"), which would otherwise ship inside a public README asset.
 *
 * This is the ONE declared exception to "every frame is the product's own
 * rendering" — a marketing capture must not publish the operator's address.
 * Framing around it is not an option: the camera falls back to a wide shot
 * whenever a stage changes fewer than `camera.minChangedCells`, which is
 * exactly the quiet "both agents working" beat the demo exists to show.
 *
 * The replacement is padded to the matched length because a serialized line
 * positions each run by absolute column — a shorter substitution would slide
 * the rest of the row.
 */
export function redactAccountIdentity(line: string): string {
  const pad = (match: string) => REDACTED.slice(0, match.length).padEnd(match.length, " ")
  // Redact TEXT ONLY. A serialized line interleaves SGR escapes with content,
  // and an address regex run over the raw string happily eats the parameter
  // tail in front of it (`…;153m` + `o2620624@…` reads as one local part),
  // truncating the escape and corrupting every cell that follows.
  let out = ""
  let last = 0
  for (const match of line.matchAll(ANSI_TOKEN)) {
    const at = match.index ?? 0
    out += line.slice(last, at).replace(EMAIL, pad) + match[0]
    last = at + match[0].length
  }
  return out + line.slice(last).replace(EMAIL, pad)
}

/** Longest a single frame may stay on screen before the hold is collapsed. */
const MAX_HOLD_SECONDS = 10

/**
 * Collapse dead air. A `sleep` beat waits in one go and snapshots once at the
 * end, so a long wait for real engines records NOTHING in between — the last
 * frame simply hangs. Seventy-odd seconds of that reads as a frozen video, and
 * no content is lost by shortening it because none was ever captured.
 *
 * Later frames shift earlier by the same amount, so the timeline stays
 * monotonic and every stage boundary keeps its frame.
 */
export function collapseIdleHolds(
  frames: readonly CaptureFrame[],
  maxHoldSeconds: number = MAX_HOLD_SECONDS,
): CaptureFrame[] {
  let shift = 0
  const out: CaptureFrame[] = []
  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1]
    if (previous) {
      const gap = frame.t - previous.t
      if (gap > maxHoldSeconds) shift += gap - maxHoldSeconds
    }
    out.push({ ...frame, t: Number((frame.t - shift).toFixed(3)) })
  }
  return out
}

const redactFrames = (frames: readonly CaptureFrame[]): CaptureFrame[] =>
  frames.map((frame) => ({
    ...frame,
    lines: frame.lines.map((line) =>
      typeof line === "string" ? redactAccountIdentity(line) : { ...line, rawAnsi: redactAccountIdentity(line.rawAnsi) },
    ),
  }))

export interface CaptureTerminal {
  start(): Promise<void>
  snapshot(): Promise<readonly string[]>
  type(text: string): Promise<void>
  key(key: string): Promise<void>
  waitFor(pattern: string, timeoutMs: number): Promise<void>
  stop(): Promise<void>
}

export interface CaptureClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface CaptureDocument {
  cols: number
  rows: number
  frames: CaptureFrame[]
  meta: { theme?: unknown }
}

export interface CaptureOutput {
  replaceAtomically(capture: CaptureDocument): Promise<void>
}

const framesMatch = (left: readonly CaptureLine[], right: readonly CaptureLine[]) =>
  left.length === right.length && left.every((line, index) => JSON.stringify(line) === JSON.stringify(right[index]))

const validateCapture = (capture: CaptureDocument) => {
  if (!Number.isFinite(capture.cols) || capture.cols <= 0 || !Number.isFinite(capture.rows) || capture.rows <= 0) {
    throw new Error("capture dimensions must be positive finite numbers")
  }
  if (capture.frames.length === 0) throw new Error("capture must contain at least one frame")
  let previous = Number.NEGATIVE_INFINITY
  for (const frame of capture.frames) {
    if (!Number.isFinite(frame.t) || frame.t < previous)
      throw new Error("capture frame timestamps must be finite and monotonic")
    if (frame.lines.length !== capture.rows) throw new Error("capture frame line count must match rows")
    previous = frame.t
  }
}

const captureSnapshot = async (
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
): Promise<readonly string[]> => {
  const lines = [...(await terminal.snapshot())]
  const last = frames.at(-1)
  if (!last || !framesMatch(last.lines, lines)) {
    const elapsed = Math.max(last?.t ?? 0, (clock.now() - startedAt) / 1000)
    frames.push({ t: frames.length === 0 ? 0 : elapsed, lines })
  }
  return lines
}

const wait = async (
  spec: ResolvedReplaySpec,
  name: string,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  const entry = spec.waits[name]
  if (!entry) throw new Error(`unknown replay wait "${name}"`)
  await terminal.waitFor(entry.pattern, entry.timeoutMs)
  await captureSnapshot(terminal, clock, startedAt, frames)
}

const pause = async (
  ms: number,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  await clock.sleep(ms)
  await captureSnapshot(terminal, clock, startedAt, frames)
}

const pollTimeline = async (
  ms: number,
  fps: number,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  const interval = 1000 / fps
  let remaining = ms
  while (remaining > 0) {
    const step = Math.min(interval, remaining)
    await clock.sleep(step)
    await captureSnapshot(terminal, clock, startedAt, frames)
    remaining = remaining - step < 0.001 ? 0 : remaining - step
  }
}

const sendKey = async (
  key: string,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  await terminal.key(key)
  return captureSnapshot(terminal, clock, startedAt, frames)
}

const typeText = async (
  text: string,
  msPerChar: number | undefined,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  const characters = [...text]
  for (const [index, character] of characters.entries()) {
    await terminal.type(character)
    await captureSnapshot(terminal, clock, startedAt, frames)
    if (index < characters.length - 1 && msPerChar !== undefined) {
      await pause(msPerChar, terminal, clock, startedAt, frames)
    }
  }
}

const runDismissRules = async (
  spec: ResolvedReplaySpec,
  rules: ResolvedReplaySpec["beats"][number]["dismissIfText"],
  lines: readonly string[],
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  let currentLines = lines
  for (const rule of rules ?? []) {
    if (!currentLines.join("\n").includes(rule.includes)) continue
    for (const step of rule.steps) {
      if (step.action === "key") currentLines = await sendKey(step.key, terminal, clock, startedAt, frames)
      if (step.action === "sleep") await pause(step.ms, terminal, clock, startedAt, frames)
      if (step.action === "waitFor") await wait(spec, step.waitFor, terminal, clock, startedAt, frames)
    }
  }
}

const runCreateTask = async (
  spec: ResolvedReplaySpec,
  engine: string | undefined,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  const flow = spec.flows?.createTask
  if (!flow) throw new Error("replay flow createTask is not configured")
  // The sidebar owns the bare `n` that opens the dialog, and a fresh boot does
  // not focus it — an unanchored `n` is simply swallowed. Use the `ctrl+a` `h`
  // prefix sequence from docs/KEYBINDINGS.md ("move focus left"): it is
  // idempotent at the leftmost pane, unlike `ctrl+q`, which focuses the
  // sidebar but QUITS when the sidebar already has focus.
  if (flow.focusPaneBeforeOpen === "leftmost") {
    await sendKey("C-a", terminal, clock, startedAt, frames)
    await sendKey("h", terminal, clock, startedAt, frames)
  }
  await sendKey(flow.openKey ?? "n", terminal, clock, startedAt, frames)
  await wait(spec, flow.dialogWait, terminal, clock, startedAt, frames)
  if (flow.dialogSettleMs !== undefined) await pause(flow.dialogSettleMs, terminal, clock, startedAt, frames)
  if (engine === "codex" && flow.codexEngineCycleKey) {
    await sendKey(flow.codexEngineCycleKey, terminal, clock, startedAt, frames)
    if (flow.codexEngineSettleMs !== undefined) {
      await pause(flow.codexEngineSettleMs, terminal, clock, startedAt, frames)
    }
  }
  for (let index = 0; index < (flow.tabCount ?? 0); index++) {
    await sendKey("Tab", terminal, clock, startedAt, frames)
    if (flow.tabDelayMs !== undefined) await pause(flow.tabDelayMs, terminal, clock, startedAt, frames)
  }
  await sendKey(flow.submitKey ?? "Enter", terminal, clock, startedAt, frames)
}

export async function runReplayCapture(
  spec: ResolvedReplaySpec,
  terminal: CaptureTerminal,
  output: CaptureOutput,
  clock: CaptureClock,
): Promise<CaptureDocument> {
  const frames: CaptureFrame[] = []
  const startedAt = clock.now()
  let nominalAt = 0

  try {
    await terminal.start()
    await captureSnapshot(terminal, clock, startedAt, frames)
    const beats = spec.beats
      .map((beat, index) => ({ beat, index }))
      .sort((left, right) => left.beat.at - right.beat.at || left.index - right.index)
    for (const { beat } of beats) {
      const delay = (beat.at - nominalAt) * 1000
      if (delay > 0) await pollTimeline(delay, spec.capture.fps, terminal, clock, startedAt, frames)
      nominalAt = beat.at
      if (beat.action === "key") await sendKey(beat.key ?? "", terminal, clock, startedAt, frames)
      // Poll, do not pause: a real engine keeps working through a sleep, and
      // `pause` snapshots only once at the end — the wait then records as a
      // single frozen frame instead of the work it was waiting for.
      if (beat.action === "sleep") {
        await pollTimeline(beat.ms ?? 0, spec.capture.fps, terminal, clock, startedAt, frames)
        // A declared zero-duration sleep is still a settle point, and polling
        // a zero span never runs — snapshot once more (a no-op when nothing
        // changed, since only differing screens are recorded).
        await captureSnapshot(terminal, clock, startedAt, frames)
      }
      if (beat.action === "waitFor" && beat.waitFor) {
        await wait(spec, beat.waitFor, terminal, clock, startedAt, frames)
        const lines = frames.at(-1)?.lines.map((line) => (typeof line === "string" ? line : line.rawAnsi)) ?? []
        await runDismissRules(spec, beat.dismissIfText, lines, terminal, clock, startedAt, frames)
      }
      if (beat.action === "flow") await runCreateTask(spec, beat.engine, terminal, clock, startedAt, frames)
      if (beat.action === "typeText" || beat.action === "typeTextWhenReady") {
        if (beat.action === "typeTextWhenReady" && beat.waitFor) {
          await wait(spec, beat.waitFor, terminal, clock, startedAt, frames)
        }
        if (beat.settleMs !== undefined) await pause(beat.settleMs, terminal, clock, startedAt, frames)
        const text = beat.text ?? (beat.textRef ? spec.text[beat.textRef] : undefined)
        if (text === undefined) throw new Error("replay text beat has no text")
        await typeText(text, beat.msPerChar, terminal, clock, startedAt, frames)
        const lines = frames.at(-1)?.lines.map((line) => (typeof line === "string" ? line : line.rawAnsi)) ?? []
        await runDismissRules(spec, beat.dismissIfText, lines, terminal, clock, startedAt, frames)
        if (beat.submit) {
          if (beat.submitDelayMs !== undefined) {
            await pause(beat.submitDelayMs, terminal, clock, startedAt, frames)
          }
          await sendKey("Enter", terminal, clock, startedAt, frames)
        }
      }
    }
    const tail = (spec.capture.seconds - nominalAt) * 1000
    if (tail > 0) await pollTimeline(tail, spec.capture.fps, terminal, clock, startedAt, frames)
    const document: CaptureDocument = {
      cols: spec.viewport.cols,
      rows: spec.viewport.rows,
      frames: collapseIdleHolds(redactFrames(frames)),
      meta: spec.theme === undefined ? {} : { theme: spec.theme },
    }
    validateCapture(document)
    await output.replaceAtomically(document)
    return document
  } finally {
    await terminal.stop()
  }
}

export async function writeCaptureAtomically(path: string, capture: CaptureDocument): Promise<void> {
  validateCapture(capture)
  const temporary = join(dirname(path), `.${path.split("/").at(-1)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(capture, null, 2)}\n`)
  await rename(temporary, path)
}
