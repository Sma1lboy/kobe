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

// Pointer-follow camera, like the original quicklook.mp4: the "pointer" of a
// TUI is wherever the screen is changing. Diff consecutive keyframes, take
// the centroid of changed cells as the gaze target, and lazily follow it.
// Screen-flooding changes (boot, full redraws) pull the camera wide; local
// changes (typing, a streaming reply) push it in.

const stripLine = (l: string) =>
  l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;]*m/g, "")

type Target = { t: number; ox: number; oy: number; spread: number }

function activityTargets(): Target[] {
  const targets: Target[] = []
  for (let i = 1; i < capture.frames.length; i++) {
    const prev = capture.frames[i - 1].lines.map(stripLine)
    const cur = capture.frames[i].lines.map(stripLine)
    // Per-row change stats.
    const rows: Array<{ r: number; n: number; sx: number }> = []
    for (let r = 0; r < cur.length; r++) {
      const a = prev[r] ?? ""
      const b = cur[r]
      if (a === b) continue
      let n = 0
      let sx = 0
      const len = Math.max(a.length, b.length)
      for (let c = 0; c < len; c++) {
        if ((a[c] ?? " ") !== (b[c] ?? " ")) {
          n++
          sx += c
        }
      }
      if (n > 0) rows.push({ r, n, sx })
    }
    // Cluster changed rows into bands (gap > 3 rows splits), follow the
    // biggest band — spinners and status-bar ticks elsewhere stop dragging
    // the camera wide or into empty space between clusters.
    let best: { n: number; sx: number; sy: number; minR: number; maxR: number } | null = null
    let cluster: typeof best = null
    for (const row of rows) {
      if (cluster && row.r - cluster.maxR <= 3) {
        cluster.n += row.n
        cluster.sx += row.sx
        cluster.sy += row.r * row.n
        cluster.maxR = row.r
      } else {
        cluster = { n: row.n, sx: row.sx, sy: row.r * row.n, minR: row.r, maxR: row.r }
      }
      if (!best || cluster.n > best.n) best = cluster
    }
    if (!best || best.n < 3) continue // ignore cursor blink / clock ticks
    targets.push({
      t: capture.frames[i].t,
      ox: (best.sx / best.n / capture.cols) * 100,
      oy: (best.sy / best.n / capture.rows) * 100,
      spread: (best.maxR - best.minR) / capture.rows,
    })
  }
  return targets
}

const OUT_FPS = 30
const TAIL = 4 // seconds of hold after the last keyframe (matches Root.tsx)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Precomputed per-output-frame camera path: exponential lag toward the
// current activity point. Deterministic — pure function of frames.json.
const CAM_PATH = (() => {
  const targets = activityTargets()
  const end = capture.frames[capture.frames.length - 1].t + TAIL
  const path: Array<{ scale: number; ox: number; oy: number }> = []
  let cam = { scale: 1, ox: 50, oy: 50 }
  let goal = { scale: 1, ox: 50, oy: 50 }
  let ti = 0
  const K = 0.055 // follow lag: ~0.6s to close half the distance at 30fps
  for (let f = 0; f <= Math.ceil(end * OUT_FPS); f++) {
    const t = f / OUT_FPS
    while (ti < targets.length && targets[ti].t <= t) {
      const g = targets[ti++]
      // Wide when the whole screen repaints, tight when the change is local.
      const scale = g.spread > 0.55 ? 1 : g.spread > 0.3 ? 1.25 : 1.55
      goal = { scale, ox: clamp(g.ox, 5, 95), oy: clamp(g.oy, 5, 95) }
    }
    if (t > end - 3) goal = { scale: 1, ox: 50, oy: 50 } // final pull-back
    cam = {
      scale: cam.scale + K * (goal.scale - cam.scale),
      ox: cam.ox + K * (goal.ox - cam.ox),
      oy: cam.oy + K * (goal.oy - cam.oy),
    }
    path.push(cam)
  }
  return path
})()

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

  const cam = CAM_PATH[Math.min(frame, CAM_PATH.length - 1)]

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
