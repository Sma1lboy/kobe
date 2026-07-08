export type RegionBounds = { c0: number; c1: number; r0: number; r1: number }
export type Region = RegionBounds & { hash: string }
export type RawRegion = RegionBounds & { hash?: string }

export type CaptureFrame = { t: number; lines: string[] }
export type CaptureMeta = { cols: number; rows: number; frames: CaptureFrame[] }

export type ViewportSpec = {
  cols: number
  rows: number
  width: number
  height: number
}

export type CaptureSpec = {
  fps: number
  seconds: number
  output: string
  home: string
  repoDefault: string
  shellPrompt: string
  socket?: string
  innerSocket?: string
  session?: string
  warmupSeconds?: number
}

export type WaitSpec = {
  pattern: string
  timeoutMs: number
}

export type ReplayStep =
  | { action: "key"; key: string }
  | { action: "sleep"; ms: number }
  | { action: "waitFor"; waitFor: string }

export type DismissRule = {
  includes: string
  steps: ReplayStep[]
}

export type ReplayBeat = {
  at: number
  action: "typeText" | "typeTextWhenReady" | "key" | "flow" | "sleep"
  text?: string
  textRef?: string
  msPerChar?: number
  submit?: boolean
  submitDelayMs?: number
  waitFor?: string
  settleMs?: number
  dismissIfText?: DismissRule[]
  key?: string
  flow?: string
  engine?: string
  ms?: number
}

export type StagePoint = number | "capture-end" | "end"

export type RawStage = {
  name: string
  from: StagePoint
  to: StagePoint
  region?: string
}

export type ResolvedStage = {
  name: string
  from: number
  to: number
  region?: Region
}

export type CameraSpec = {
  transitionSeconds: number
  fit: number
  minScale: number
  maxScale: number
  tailHoldSeconds: number
  minChangedCells?: number
  rowGap?: number
  colQuantiles?: [number, number]
}

export type ResolvedCameraSpec = Required<CameraSpec>

export type CreateTaskFlowSpec = {
  openKey?: string
  focusPaneBeforeOpen?: "leftmost"
  dialogWait: string
  dialogSettleMs?: number
  codexEngineCycleKey?: string
  codexEngineSettleMs?: number
  tabCount?: number
  tabDelayMs?: number
  submitKey?: string
}

export type ReplayFlows = {
  createTask?: CreateTaskFlowSpec
}

export type SeedTask = {
  title: string
  status: string
}

export type ReplaySetup = {
  seedTasks?: SeedTask[]
}

export type DeliverySpec = {
  speedCuts?: number[]
  posterAt?: number
}

export type RawReplaySpec = {
  id: string
  viewport: ViewportSpec
  capture: CaptureSpec
  setup?: ReplaySetup
  waits: Record<string, WaitSpec>
  text: Record<string, string>
  flows?: ReplayFlows
  beats: ReplayBeat[]
  regions: Record<string, RawRegion>
  stages: RawStage[]
  camera: CameraSpec
  delivery?: DeliverySpec
}

export type ResolvedReplaySpec = Omit<RawReplaySpec, "camera" | "regions" | "stages"> & {
  camera: ResolvedCameraSpec
  regions: Record<string, Region>
  stages: ResolvedStage[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const assertObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!isObject(value)) throw new Error(`replay spec ${name} must be an object`)
  return value
}

const assertArray = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`replay spec ${name} must be an array`)
  return value
}

const assertNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`replay spec ${name} must be a finite number`)
  }
  return value
}

const assertString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`replay spec ${name} must be a non-empty string`)
  }
  return value
}

const lastCaptureTime = (capture: CaptureMeta): number => capture.frames.at(-1)?.t ?? 0

export function regionCoordinateHash(
  name: string,
  region: RegionBounds,
  capture: Pick<CaptureMeta, "cols" | "rows">,
): string {
  const input = `v1|${name}|${capture.cols}x${capture.rows}|${region.c0},${region.c1},${region.r0},${region.r1}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `rg_${hash.toString(36).padStart(7, "0")}`
}

const assertRegion = (region: RawRegion, name: string, capture: CaptureMeta): Region => {
  for (const key of ["c0", "c1", "r0", "r1"] as const) assertNumber(region[key], `${name}.${key}`)
  if (region.hash !== undefined) assertString(region.hash, `${name}.hash`)
  if (region.c0 < 0 || region.c1 >= capture.cols || region.r0 < 0 || region.r1 >= capture.rows) {
    throw new Error(`replay spec ${name} is outside the ${capture.cols}x${capture.rows} capture grid`)
  }
  if (region.c0 > region.c1 || region.r0 > region.r1) throw new Error(`replay spec ${name} has inverted bounds`)
  return { ...region, hash: region.hash ?? regionCoordinateHash(name.replace(/^regions\./, ""), region, capture) }
}

const assertWaitRef = (waits: Record<string, WaitSpec>, waitFor: string | undefined, owner: string) => {
  if (waitFor && !waits[waitFor]) throw new Error(`${owner} references unknown wait "${waitFor}"`)
}

const assertTextRef = (text: Record<string, string>, textRef: string | undefined, owner: string) => {
  if (textRef && !text[textRef]) throw new Error(`${owner} references unknown text "${textRef}"`)
}

const resolvePoint = (point: StagePoint, captureEnd: number, tailHoldSeconds: number, name: string): number => {
  if (typeof point === "number" && Number.isFinite(point)) return point
  if (point === "capture-end") return captureEnd
  if (point === "end") return captureEnd + tailHoldSeconds
  throw new Error(`replay spec stage "${name}" has invalid time point "${String(point)}"`)
}

const resolveCamera = (camera: CameraSpec): ResolvedCameraSpec => {
  const rawColQuantiles = camera.colQuantiles ?? [0.05, 0.95]
  if (
    rawColQuantiles.length !== 2 ||
    rawColQuantiles[0] < 0 ||
    rawColQuantiles[1] > 1 ||
    rawColQuantiles[0] >= rawColQuantiles[1]
  ) {
    throw new Error("replay spec camera.colQuantiles must be an increasing pair inside [0, 1]")
  }
  const colQuantiles: [number, number] = [rawColQuantiles[0], rawColQuantiles[1]]
  return {
    transitionSeconds: camera.transitionSeconds,
    fit: camera.fit,
    minScale: camera.minScale,
    maxScale: camera.maxScale,
    tailHoldSeconds: camera.tailHoldSeconds,
    minChangedCells: camera.minChangedCells ?? 10,
    rowGap: camera.rowGap ?? 3,
    colQuantiles,
  }
}

export function replayDurationSeconds(spec: { camera: { tailHoldSeconds: number } }, capture: CaptureMeta): number {
  return lastCaptureTime(capture) + spec.camera.tailHoldSeconds
}

export function resolveReplaySpec(raw: unknown, capture: CaptureMeta): ResolvedReplaySpec {
  const root = assertObject(raw, "root")
  const spec = raw as RawReplaySpec
  assertString(root.id, "id")
  assertObject(root.viewport, "viewport")
  assertObject(root.capture, "capture")
  assertObject(root.waits, "waits")
  assertObject(root.text, "text")
  assertObject(root.regions, "regions")
  assertObject(root.camera, "camera")
  assertArray(root.beats, "beats")
  assertArray(root.stages, "stages")

  const viewport = spec.viewport
  for (const key of ["cols", "rows", "width", "height"] as const) assertNumber(viewport[key], `viewport.${key}`)
  if (capture.cols !== viewport.cols || capture.rows !== viewport.rows) {
    throw new Error(
      `replay spec viewport ${viewport.cols}x${viewport.rows} does not match capture ${capture.cols}x${capture.rows}`,
    )
  }

  const camera = resolveCamera(spec.camera)
  const rawRegions: Record<string, RawRegion> = {
    ...spec.regions,
    full: { c0: 0, c1: capture.cols - 1, r0: 0, r1: capture.rows - 1 },
  }
  const regions: Record<string, Region> = {}
  for (const [name, region] of Object.entries(rawRegions)) {
    regions[name] = assertRegion(region, `regions.${name}`, capture)
  }

  for (const [name, wait] of Object.entries(spec.waits)) {
    assertString(wait.pattern, `waits.${name}.pattern`)
    assertNumber(wait.timeoutMs, `waits.${name}.timeoutMs`)
  }
  for (const [name, value] of Object.entries(spec.text)) assertString(value, `text.${name}`)

  for (const [i, beat] of spec.beats.entries()) {
    assertNumber(beat.at, `beats[${i}].at`)
    assertString(beat.action, `beats[${i}].action`)
    assertWaitRef(spec.waits, beat.waitFor, `beat ${i}`)
    assertTextRef(spec.text, beat.textRef, `beat ${i}`)
    for (const [ruleIndex, rule] of (beat.dismissIfText ?? []).entries()) {
      assertString(rule.includes, `beats[${i}].dismissIfText[${ruleIndex}].includes`)
      for (const [stepIndex, step] of rule.steps.entries()) {
        if (step.action === "waitFor") assertWaitRef(spec.waits, step.waitFor, `beat ${i} dismiss step ${stepIndex}`)
      }
    }
  }

  if (spec.flows?.createTask) {
    assertWaitRef(spec.waits, spec.flows.createTask.dialogWait, "flow createTask")
    const focusPane = spec.flows.createTask.focusPaneBeforeOpen
    if (focusPane !== undefined && focusPane !== "leftmost") {
      throw new Error('flow createTask.focusPaneBeforeOpen must be "leftmost" when set')
    }
  }

  const captureEnd = lastCaptureTime(capture)
  const stages = spec.stages.map((stage, i) => {
    assertString(stage.name, `stages[${i}].name`)
    const from = resolvePoint(stage.from, captureEnd, camera.tailHoldSeconds, stage.name)
    const to = resolvePoint(stage.to, captureEnd, camera.tailHoldSeconds, stage.name)
    if (to <= from) throw new Error(`replay spec stage "${stage.name}" must end after it starts`)
    if (!stage.region) return { name: stage.name, from, to }
    const region = regions[stage.region]
    if (!region) throw new Error(`replay spec stage "${stage.name}" references unknown region "${stage.region}"`)
    return { name: stage.name, from, to, region }
  })

  return { ...spec, camera, regions, stages }
}
