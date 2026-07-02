import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors } from "./theme"
import { ContentBars, SceneShell } from "./ui"
import { WindowCard } from "./ui"

// Five sessions drift from a tidy grid into an overlapping mess while the
// hook line lands. Deterministic: every "random" offset is a hand-picked
// constant per card.
const CARDS = [
  { title: "claude — fix-auth", tidy: { x: 90, y: 320 }, messy: { x: 60, y: 430, r: -9 } },
  { title: "claude — new-api", tidy: { x: 560, y: 320 }, messy: { x: 430, y: 360, r: 7 } },
  { title: "codex — refactor", tidy: { x: 90, y: 700 }, messy: { x: 150, y: 760, r: 12 } },
  { title: "claude — bugfix", tidy: { x: 560, y: 700 }, messy: { x: 490, y: 640, r: -6 } },
  { title: "claude — docs", tidy: { x: 325, y: 1080 }, messy: { x: 300, y: 900, r: 4 } },
]
const BAR_SEEDS = [
  [80, 55, 92, 40, 66],
  [60, 88, 45, 72, 30],
  [92, 38, 70, 55, 84],
  [48, 76, 60, 90, 35],
  [70, 50, 85, 42, 78],
]

export const Scene01Chaos: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  // Tidy for ~1.2s, then each card springs to its messy pose with a stagger.
  const hookIn = spring({ frame, fps, config: { damping: 200 } })
  return (
    <SceneShell caption="你有没有同时开过五个 AI coding 会话？窗口一多，上下文就全乱了。">
      {CARDS.map((c, i) => {
        const mess = spring({
          frame: frame - (1.2 + i * 0.12) * fps,
          fps,
          config: { damping: 14, mass: 0.8 },
        })
        // Late micro-shake sells "out of control" without real randomness.
        const shake = Math.sin((frame / fps) * 9 + i * 2.1) * 4 * mess
        const x = c.tidy.x + (c.messy.x - c.tidy.x) * mess + shake
        const y = c.tidy.y + (c.messy.y - c.tidy.y) * mess
        const r = c.messy.r * mess
        return (
          <div key={c.title} style={{ position: "absolute", left: x, top: y, transform: `rotate(${r}deg)` }}>
            <WindowCard width={440} height={330} title={c.title}>
              <ContentBars rows={7} seedWidths={BAR_SEEDS[i]} />
            </WindowCard>
          </div>
        )
      })}
      <div
        style={{
          position: "absolute",
          top: 130,
          left: 80,
          right: 80,
          textAlign: "center",
          color: colors.fg,
          fontSize: 76,
          fontWeight: 700,
          lineHeight: 1.35,
          opacity: hookIn,
          transform: `translateY(${(1 - hookIn) * 40}px)`,
        }}
      >
        5 个会话同时跑，
        <br />
        <span style={{ color: colors.blue }}>上下文全乱了？</span>
      </div>
      {/* Dim veil grows as the mess peaks, setting up scene 2's reveal. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: colors.bg,
          opacity: interpolate(frame, [3.6 * fps, 4.5 * fps], [0, 0.55], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          pointerEvents: "none",
        }}
      />
    </SceneShell>
  )
}
