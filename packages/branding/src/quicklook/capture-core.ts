import { rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { CaptureFrame, CaptureLine, ResolvedReplaySpec } from "./replay-spec"

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
  let previous = -Infinity
  for (const frame of capture.frames) {
    if (!Number.isFinite(frame.t) || frame.t < previous) throw new Error("capture frame timestamps must be finite and monotonic")
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

const sleep = async (
  ms: number,
  terminal: CaptureTerminal,
  clock: CaptureClock,
  startedAt: number,
  frames: CaptureFrame[],
) => {
  if (ms <= 0) return
  await clock.sleep(ms)
  await captureSnapshot(terminal, clock, startedAt, frames)
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
    if (index < characters.length - 1 && msPerChar) await sleep(msPerChar, terminal, clock, startedAt, frames)
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
  for (const rule of rules ?? []) {
    if (!lines.join("\n").includes(rule.includes)) continue
    for (const step of rule.steps) {
      if (step.action === "key") lines = await sendKey(step.key, terminal, clock, startedAt, frames)
      if (step.action === "sleep") await sleep(step.ms, terminal, clock, startedAt, frames)
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
  if (flow.focusPaneBeforeOpen === "leftmost") await sendKey("C-h", terminal, clock, startedAt, frames)
  await sendKey(flow.openKey ?? "n", terminal, clock, startedAt, frames)
  await wait(spec, flow.dialogWait, terminal, clock, startedAt, frames)
  await sleep(flow.dialogSettleMs ?? 0, terminal, clock, startedAt, frames)
  if (engine === "codex" && flow.codexEngineCycleKey) {
    await sendKey(flow.codexEngineCycleKey, terminal, clock, startedAt, frames)
    await sleep(flow.codexEngineSettleMs ?? 0, terminal, clock, startedAt, frames)
  }
  for (let index = 0; index < (flow.tabCount ?? 0); index++) {
    await sendKey("Tab", terminal, clock, startedAt, frames)
    await sleep(flow.tabDelayMs ?? 0, terminal, clock, startedAt, frames)
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
    for (const beat of spec.beats) {
      await sleep(Math.max(0, (beat.at - nominalAt) * 1000), terminal, clock, startedAt, frames)
      nominalAt = beat.at
      if (beat.action === "key") await sendKey(beat.key ?? "", terminal, clock, startedAt, frames)
      if (beat.action === "sleep") await sleep(beat.ms ?? 0, terminal, clock, startedAt, frames)
      if (beat.action === "flow") await runCreateTask(spec, beat.engine, terminal, clock, startedAt, frames)
      if (beat.action === "typeText" || beat.action === "typeTextWhenReady") {
        if (beat.action === "typeTextWhenReady" && beat.waitFor) {
          await wait(spec, beat.waitFor, terminal, clock, startedAt, frames)
        }
        await sleep(beat.settleMs ?? 0, terminal, clock, startedAt, frames)
        const text = beat.text ?? (beat.textRef ? spec.text[beat.textRef] : undefined)
        if (text === undefined) throw new Error("replay text beat has no text")
        await typeText(text, beat.msPerChar, terminal, clock, startedAt, frames)
        const lines = frames.at(-1)?.lines.map((line) => (typeof line === "string" ? line : line.rawAnsi)) ?? []
        await runDismissRules(spec, beat.dismissIfText, lines, terminal, clock, startedAt, frames)
        if (beat.submit) {
          await sleep(beat.submitDelayMs ?? 0, terminal, clock, startedAt, frames)
          await sendKey("Enter", terminal, clock, startedAt, frames)
        }
      }
    }
    const document: CaptureDocument = {
      cols: spec.viewport.cols,
      rows: spec.viewport.rows,
      frames,
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
