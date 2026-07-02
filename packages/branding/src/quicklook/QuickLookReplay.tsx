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

// Stage boundaries mirror the capture script's beats.
// `wide: true` forces a full shot (boot repaints everything; wrap pulls out).
const STAGES: Array<{ name: string; from: number; to: number; wide?: boolean }> = [
  { name: "shell", from: 0, to: 2.5 }, // $ kobe typed
  { name: "boot", from: 2.5, to: 8, wide: true }, // TUI paints — full shot
  { name: "task-created", from: 8, to: 14 }, // sidebar: task appears, selected
  { name: "open-task", from: 14, to: 26, wide: true }, // workspace attaches, engine boots
  { name: "prompt", from: 26, to: 31 }, // prompt pasted into composer
  { name: "agent", from: 31, to: END - 4 }, // tool stream
  { name: "wrap", from: END - 4, to: END, wide: true }, // pull back out
]

type Shot = { scale: number; ox: number; oy: number }
const WIDE: Shot = { scale: 1, ox: 50, oy: 50 }

// Frame a stage: union of every cell that changed during it, trimmed to the
// 5–95% weight quantiles so a stray spinner/status tick can't stretch the box.
function frameStage(from: number, to: number): Shot {
  const rowW = new Array(capture.rows).fill(0)
  const colW = new Array(capture.cols).fill(0)
  let total = 0
  for (let i = 1; i < capture.frames.length; i++) {
    if (capture.frames[i].t < from || capture.frames[i].t >= to) continue
    const prev = capture.frames[i - 1].lines.map(stripLine)
    const cur = capture.frames[i].lines.map(stripLine)
    for (let r = 0; r < cur.length; r++) {
      const a = prev[r] ?? ""
      const b = cur[r]
      if (a === b) continue
      const len = Math.max(a.length, b.length)
      for (let c = 0; c < len; c++) {
        if ((a[c] ?? " ") !== (b[c] ?? " ")) {
          rowW[r] = (rowW[r] ?? 0) + 1
          colW[c] = (colW[c] ?? 0) + 1
          total++
        }
      }
    }
  }
  if (total < 10) return WIDE
  const span = (w: number[]): [number, number] => {
    const sum = w.reduce((a, b) => a + b, 0)
    let acc = 0
    let lo = 0
    let hi = w.length - 1
    for (let i = 0; i < w.length; i++) {
      acc += w[i]
      if (acc < sum * 0.05) lo = i + 1
      if (acc <= sum * 0.95) hi = i
    }
    return [lo, Math.max(lo, hi)]
  }
  const [r0, r1] = span(rowW)
  const [c0, c1] = span(colW)
  const h = (r1 - r0 + 1) / capture.rows
  const w = (c1 - c0 + 1) / capture.cols
  // Fit the box into ~80% of the viewport, capped so text stays crisp.
  const scale = clamp(0.8 / Math.max(w, h), 1, 1.6)
  return {
    scale,
    ox: clamp(((c0 + c1) / 2 / capture.cols) * 100, 5, 95),
    oy: clamp(((r0 + r1) / 2 / capture.rows) * 100, 5, 95),
  }
}

const SHOTS: Shot[] = STAGES.map((s) => (s.wide ? WIDE : frameStage(s.from, s.to)))

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
    ox: prev.ox + (shot.ox - prev.ox) * p,
    oy: prev.oy + (shot.oy - prev.oy) * p,
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

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, fontFamily: monoStack }}>
      <div
        style={{
          width: 1280,
          height: 720,
          fontSize: CELL_W / 0.6,
          lineHeight: `${LINE_H}px`,
          transform: `scale(${cam.scale})`,
          transformOrigin: `${cam.ox}% ${cam.oy}%`,
        }}
      >
        {lines.map((spans, i) => (
          <Line key={i} spans={spans} />
        ))}
      </div>
    </AbsoluteFill>
  )
}
