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

// Camera storyboard replicating the original quicklook.mp4 motion:
// wide on launch, push into the workspace when the task starts, deep zoom on
// the agent's tool stream, pan to the files/terminal column, pull back out.
// {t: seconds, scale, ox/oy: transform-origin %}
const CAMERA = [
  { t: 0, scale: 1, ox: 50, oy: 50 },
  { t: 8, scale: 1, ox: 50, oy: 50 }, // launch + workspace wide
  { t: 11, scale: 1.45, ox: 20, oy: 30 }, // sidebar: task appears + selected
  { t: 15, scale: 1.45, ox: 20, oy: 30 },
  { t: 18, scale: 1.25, ox: 45, oy: 30 }, // workspace: engine boots
  { t: 27, scale: 1.25, ox: 45, oy: 30 },
  { t: 31, scale: 1.6, ox: 40, oy: 28 }, // deep: prompt + tool stream
  { t: 49, scale: 1.6, ox: 40, oy: 28 },
  { t: 55, scale: 1.15, ox: 50, oy: 45 },
  { t: 61, scale: 1, ox: 50, oy: 50 }, // pull back wide
]

const ease = (p: number) => p * p * (3 - 2 * p)

function cameraAt(t: number) {
  let a = CAMERA[0]
  let b = CAMERA[CAMERA.length - 1]
  for (let i = 0; i < CAMERA.length - 1; i++) {
    if (t >= CAMERA[i].t && t <= CAMERA[i + 1].t) {
      a = CAMERA[i]
      b = CAMERA[i + 1]
      break
    }
  }
  if (t >= b.t) return b
  const p = ease((t - a.t) / (b.t - a.t || 1))
  const mix = (x: number, y: number) => x + (y - x) * p
  return { scale: mix(a.scale, b.scale), ox: mix(a.ox, b.ox), oy: mix(a.oy, b.oy) }
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
