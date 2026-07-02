import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "../colors"
import { parseAnsiLine, type Span } from "./ansi"
import capture from "./frames.json"

// Replays a captured kobe TUI session (scripts/capture-tui.ts output) as the
// landing-page quicklook video. UI iterates -> re-run capture -> re-render;
// no manual screen recording.

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

const Line: React.FC<{ spans: Span[] }> = ({ spans }) => (
  <div style={{ height: LINE_H, whiteSpace: "pre" }}>
    {spans.map((s, i) => (
      <span
        key={i}
        style={{
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
    ))}
  </div>
)

// Stage camera. The demo is a scripted storyboard (scripts/capture-tui.ts
// beats), so the camera is too: one fixed shot per stage, framed on the
// region that actually changed during that stage, eased between stages.
// No per-frame tracking — nothing to twitch.

const stripLine = (l: string) =>
  l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;]*m/g, "")

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const END = capture.frames[capture.frames.length - 1].t + 4 // + tail hold (matches Root.tsx)

// Grid rect a stage is allowed to look at — the pane the story is about.
// Chrome (composer/status/footer) and unrelated panes stay out of frame.
type Region = { c0: number; c1: number; r0: number; r1: number }
const FULL: Region = { c0: 0, c1: capture.cols - 1, r0: 0, r1: capture.rows - 1 }
const SIDEBAR: Region = { c0: 0, c1: 31, r0: 0, r1: 30 } // excludes keys-help footer
const CHAT: Region = { c0: 33, c1: 107, r0: 3, r1: 36 } // workspace conversation area

// Stage boundaries mirror the capture script's beats.
// No region = wide shot (boot repaints everything; wrap pulls out).
const STAGES: Array<{ name: string; from: number; to: number; region?: Region }> = [
  { name: "shell", from: 0, to: 2.5, region: FULL }, // $ kobe typed
  { name: "boot", from: 2.5, to: 8 }, // TUI paints — full shot
  { name: "task-created", from: 8, to: 14, region: SIDEBAR }, // task appears, selected
  { name: "open-task", from: 14, to: 26 }, // workspace attaches, engine boots
  { name: "prompt", from: 26, to: 31, region: CHAT }, // prompt pasted + submitted
  { name: "agent", from: 31, to: END - 4, region: CHAT }, // tool stream
  { name: "wrap", from: END - 4, to: END }, // pull back out
]

// A shot is a scale + the content point (px) to center in the viewport.
type Shot = { scale: number; cx: number; cy: number }
const WIDE: Shot = { scale: 1, cx: 640, cy: 360 }

// Frame a stage: mark every cell inside the stage's region that changed at
// least once (binary — a spinner redrawing 50 times counts once), cluster
// changed rows into bands (gap > 3 splits), and frame the biggest band.
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
  // Biggest row band.
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
  // Column span: 5–95% weight quantiles within the winning band.
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
  // Fit the band into ~80% of the viewport, capped so text stays crisp.
  const scale = clamp(Math.min((1280 * 0.8) / w, (720 * 0.8) / h), 1, 1.6)
  return { scale, cx: ((c0 + c1 + 1) / 2) * CELL_W, cy: ((best.r0 + best.r1 + 1) / 2) * LINE_H }
}

const SHOTS: Shot[] = STAGES.map((s) => (s.region ? frameStage(s.from, s.to, s.region) : WIDE))

const easeInOut = (p: number) => p * p * (3 - 2 * p)
const TRANSITION = 1.2 // seconds to move between stage shots

function cameraAt(t: number): Shot {
  let i = STAGES.length - 1
  for (let s = 0; s < STAGES.length; s++) {
    if (t >= STAGES[s].from && t < STAGES[s].to) {
      i = s
      break
    }
  }
  const shot = SHOTS[i]
  if (i === 0) return shot
  const into = t - STAGES[i].from
  if (into >= TRANSITION) return shot
  const prev = SHOTS[i - 1]
  const p = easeInOut(into / TRANSITION)
  return {
    scale: prev.scale + (shot.scale - prev.scale) * p,
    cx: prev.cx + (shot.cx - prev.cx) * p,
    cy: prev.cy + (shot.cy - prev.cy) * p,
  }
}

export const QuickLookReplay: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps

  const snapshot = frameAt(t)
  let state = {}
  const lines = snapshot.lines.map((line) => {
    const parsed = parseAnsiLine(line, state)
    state = parsed.state
    return parsed.spans
  })

  const cam = cameraAt(t)
  // Center the shot's target point, clamped so the viewport never leaves the
  // content — a target near an edge sticks to that edge instead of cropping.
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
