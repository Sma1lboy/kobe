import { loadFont } from "@remotion/google-fonts/JetBrainsMono"
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "../colors"

// Bundle the real font: the fallback mono has a different advance width, so
// the 160-col grid wouldn't fill 1280px and the frame shows bg "black bars".
loadFont("normal", { weights: ["400", "700"] })
import { parseAnsiLine, type Span } from "./ansi"
import capture from "./frames.json"
import replaySpecJson from "./quicklook.replay.json"
import { resolveReplaySpec, type Region } from "./replay-spec"

// Replays a captured kobe TUI session (scripts/capture-tui.ts output) as the
// landing-page quicklook video. UI iterates -> re-run capture -> re-render;
// no manual screen recording.

const replaySpec = resolveReplaySpec(replaySpecJson, capture)
const VIEW_W = replaySpec.viewport.width
const VIEW_H = replaySpec.viewport.height
const CELL_W = VIEW_W / capture.cols
const LINE_H = VIEW_H / capture.rows

function frameAt(t: number) {
  let current = capture.frames[0]
  for (const f of capture.frames) {
    if (f.t <= t) current = f
    else break
  }
  return current
}

// Spans are pinned to their grid column, not flowed: glyphs missing from
// JetBrains Mono (nerd-font icons, braille spinners) fall back to a font
// with a different advance width, and flowed layout lets that drift shift
// everything after them — pane borders stopped lining up.
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

// Stage camera. The demo is a scripted storyboard (scripts/capture-tui.ts
// beats), so the camera is too: one fixed shot per stage, framed on the
// region that actually changed during that stage, eased between stages.
// No per-frame tracking — nothing to twitch.

const stripLine = (l: string) =>
  l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;]*m/g, "")

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const STAGES = replaySpec.stages

// A shot is a scale + the content point (px) to center in the viewport.
type Shot = { scale: number; cx: number; cy: number }
const WIDE: Shot = { scale: 1, cx: VIEW_W / 2, cy: VIEW_H / 2 }

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
  if (total < replaySpec.camera.minChangedCells) return WIDE
  const rowW = heat.map((row) => row.reduce((a, b) => a + b, 0))
  // Biggest row band.
  type Band = { w: number; r0: number; r1: number }
  let best: Band | null = null
  let band: Band | null = null
  for (let r = region.r0; r <= region.r1; r++) {
    if (!rowW[r]) continue
    if (band && r - band.r1 <= replaySpec.camera.rowGap) {
      band.w += rowW[r]
      band.r1 = r
    } else {
      band = { w: rowW[r], r0: r, r1: r }
    }
    if (!best || band.w > best.w) best = band
  }
  if (!best) return WIDE
  // Column span: configured weight quantiles within the winning band.
  const colW = new Array(capture.cols).fill(0)
  for (let r = best.r0; r <= best.r1; r++) for (let c = region.c0; c <= region.c1; c++) colW[c] += heat[r][c]
  const sum = colW.reduce((a: number, b: number) => a + b, 0)
  let acc = 0
  let c0 = region.c0
  let c1 = region.c1
  const [q0, q1] = replaySpec.camera.colQuantiles
  for (let c = region.c0; c <= region.c1; c++) {
    acc += colW[c]
    if (acc < sum * q0) c0 = c + 1
    if (acc <= sum * q1) c1 = c
  }
  c1 = Math.max(c0, c1)
  const w = (c1 - c0 + 1) * CELL_W
  const h = (best.r1 - best.r0 + 1) * LINE_H
  // Fit the band into the configured portion of the viewport, capped so text stays crisp.
  const scale = clamp(
    Math.min((VIEW_W * replaySpec.camera.fit) / w, (VIEW_H * replaySpec.camera.fit) / h),
    replaySpec.camera.minScale,
    replaySpec.camera.maxScale,
  )
  return { scale, cx: ((c0 + c1 + 1) / 2) * CELL_W, cy: ((best.r0 + best.r1 + 1) / 2) * LINE_H }
}

const SHOTS: Shot[] = STAGES.map((s) => (s.region ? frameStage(s.from, s.to, s.region) : WIDE))

const easeInOut = (p: number) => p * p * (3 - 2 * p)
const TRANSITION = replaySpec.camera.transitionSeconds // seconds of OUTPUT time to move between stage shots

// `t` is capture time; `speed` is the content playback rate. Camera easing
// runs in OUTPUT time — a sped-up render must not speed up the zooms too —
// and each move is clamped to half the stage's on-screen duration so short
// (sped-up) stages still settle instead of drifting the whole time.
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
  // Each capture-pane line is self-contained (leading unstyled cells mean
  // DEFAULT bg) — carrying SGR state across lines painted a stray trailing
  // bg color onto the next line's leading spaces (black band left of dialogs).
  const lines = snapshot.lines.map((line) => parseAnsiLine(line).spans)

  const cam = cameraAt(t, speed)
  // Center the shot's target point, clamped so the viewport never leaves the
  // content — a target near an edge sticks to that edge instead of cropping.
  const tx = clamp(VIEW_W / 2 - cam.cx * cam.scale, VIEW_W * (1 - cam.scale), 0)
  const ty = clamp(VIEW_H / 2 - cam.cy * cam.scale, VIEW_H * (1 - cam.scale), 0)

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, fontFamily: monoStack }}>
      <div
        style={{
          width: VIEW_W,
          height: VIEW_H,
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
