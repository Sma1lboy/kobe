import { loadFont } from "@remotion/google-fonts/JetBrainsMono"
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "../colors"

loadFont("normal", { weights: ["400", "700"] })
import { parseAnsiLine, type Span } from "./ansi"
import capture from "./frames.json"


const CELL_W = 1280 / capture.cols
const LINE_H = 720 / capture.rows

function frameAt(t: number) {
  let current = capture.frames[0]
  for (const f of capture.frames) {
    if (f.t <= t) current = f
    else break
  }
  return current
}

const Line: React.FC<{ spans: Span[] }> = ({ spans }) => {
  let col = 0
  return (
    <div style={{ height: LINE_H, position: "relative" }}>
      {spans.map((s, i) => {
        const at = col
        col += [...s.text].length
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              left: at * CELL_W,
              top: 0,
              whiteSpace: "pre",
              color: s.fg ?? colors.fg,
              backgroundColor: s.bg,
              fontWeight: s.bold ? 700 : 400,
              opacity: s.dim ? 0.6 : 1,
              fontStyle: s.italic ? "italic" : undefined,
              textDecoration: s.underline ? "underline" : undefined,
            }}
          >
            {s.text}
          </span>
        )
      })}
    </div>
  )
}


const stripLine = (l: string) =>
  l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;]*m/g, "")

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const END = capture.frames[capture.frames.length - 1].t + 4

type Region = { c0: number; c1: number; r0: number; r1: number }
const FULL: Region = { c0: 0, c1: capture.cols - 1, r0: 0, r1: capture.rows - 1 }
const CHAT: Region = { c0: 33, c1: 107, r0: 3, r1: 36 }
const AGENT: Region = { c0: 33, c1: 107, r0: 11, r1: 36 }
const DIALOG: Region = { c0: 30, c1: 130, r0: 6, r1: 38 }
const INPUT: Region = { c0: 33, c1: 110, r0: 37, r1: 44 }
const INPUT_CODEX: Region = { c0: 33, c1: 110, r0: 22, r1: 40 }

const STAGES: Array<{ name: string; from: number; to: number; region?: Region }> = [
  { name: "shell", from: 0, to: 2.7, region: FULL },
  { name: "boot", from: 2.7, to: 8 },
  { name: "dialog", from: 8, to: 15, region: DIALOG },
  { name: "engine-boot", from: 15, to: 31 },
  { name: "type-prompt", from: 31, to: 39, region: INPUT },
  { name: "agent", from: 39, to: 60, region: AGENT },
  { name: "dialog-codex", from: 60, to: 68, region: DIALOG },
  { name: "codex-boot", from: 68, to: 85 },
  { name: "type-codex", from: 85, to: 95, region: INPUT_CODEX },
  { name: "agent-2", from: 95, to: END - 4, region: AGENT },
  { name: "wrap", from: END - 4, to: END },
]

type Shot = { scale: number; cx: number; cy: number }
const WIDE: Shot = { scale: 1, cx: 640, cy: 360 }

function frameStage(from: number, to: number, region: Region): Shot {
  const heat: number[][] = Array.from({ length: capture.rows }, () => new Array(capture.cols).fill(0))
  let total = 0
  for (let i = 1; i < capture.frames.length; i++) {
    if (capture.frames[i].t < from || capture.frames[i].t >= to) continue
    const prev = capture.frames[i - 1].lines.map(stripLine)
    const cur = capture.frames[i].lines.map(stripLine)
    for (let r = region.r0; r <= Math.min(region.r1, cur.length - 1); r++) {
      const a = prev[r] ?? ""
      const b = cur[r]
      if (a === b) continue
      for (let c = region.c0; c <= region.c1; c++) {
        if ((a[c] ?? " ") !== (b[c] ?? " ") && heat[r][c] === 0) {
          heat[r][c] = 1
          total++
        }
      }
    }
  }
  if (total < 10) return WIDE
  const rowW = heat.map((row) => row.reduce((a, b) => a + b, 0))
  let best: { w: number; r0: number; r1: number } | null = null
  let band: typeof best = null
  for (let r = region.r0; r <= region.r1; r++) {
    if (!rowW[r]) continue
    if (band && r - band.r1 <= 3) {
      band.w += rowW[r]
      band.r1 = r
    } else {
      band = { w: rowW[r], r0: r, r1: r }
    }
    if (!best || band.w > best.w) best = band
  }
  if (!best) return WIDE
  const colW = new Array(capture.cols).fill(0)
  for (let r = best.r0; r <= best.r1; r++) for (let c = region.c0; c <= region.c1; c++) colW[c] += heat[r][c]
  const sum = colW.reduce((a: number, b: number) => a + b, 0)
  let acc = 0
  let c0 = region.c0
  let c1 = region.c1
  for (let c = region.c0; c <= region.c1; c++) {
    acc += colW[c]
    if (acc < sum * 0.05) c0 = c + 1
    if (acc <= sum * 0.95) c1 = c
  }
  c1 = Math.max(c0, c1)
  const w = (c1 - c0 + 1) * CELL_W
  const h = (best.r1 - best.r0 + 1) * LINE_H
  const scale = clamp(Math.min((1280 * 0.8) / w, (720 * 0.8) / h), 1, 1.6)
  return { scale, cx: ((c0 + c1 + 1) / 2) * CELL_W, cy: ((best.r0 + best.r1 + 1) / 2) * LINE_H }
}

const SHOTS: Shot[] = STAGES.map((s) => (s.region ? frameStage(s.from, s.to, s.region) : WIDE))

const easeInOut = (p: number) => p * p * (3 - 2 * p)
const TRANSITION = 1.2

function cameraAt(t: number, speed: number): Shot {
  let i = STAGES.length - 1
  for (let s = 0; s < STAGES.length; s++) {
    if (t >= STAGES[s].from && t < STAGES[s].to) {
      i = s
      break
    }
  }
  const shot = SHOTS[i]
  if (i === 0) return shot
  const stageOut = (STAGES[i].to - STAGES[i].from) / speed
  const transition = Math.min(TRANSITION, stageOut * 0.5)
  const into = (t - STAGES[i].from) / speed
  if (into >= transition) return shot
  const prev = SHOTS[i - 1]
  const p = easeInOut(into / transition)
  return {
    scale: prev.scale + (shot.scale - prev.scale) * p,
    cx: prev.cx + (shot.cx - prev.cx) * p,
    cy: prev.cy + (shot.cy - prev.cy) * p,
  }
}

export const QuickLookReplay: React.FC<{ speed?: number }> = ({ speed = 1 }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = (frame / fps) * speed

  const snapshot = frameAt(t)
  const lines = snapshot.lines.map((line) => parseAnsiLine(line).spans)

  const cam = cameraAt(t, speed)
  const tx = clamp(640 - cam.cx * cam.scale, 1280 * (1 - cam.scale), 0)
  const ty = clamp(360 - cam.cy * cam.scale, 720 * (1 - cam.scale), 0)

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, fontFamily: monoStack }}>
      <div
        style={{
          width: 1280,
          height: 720,
          fontSize: CELL_W / 0.6,
          lineHeight: `${LINE_H}px`,
          transform: `translate(${tx}px, ${ty}px) scale(${cam.scale})`,
          transformOrigin: "0 0",
        }}
      >
        {lines.map((spans, i) => (
          <Line key={i} spans={spans} />
        ))}
      </div>
    </AbsoluteFill>
  )
}
