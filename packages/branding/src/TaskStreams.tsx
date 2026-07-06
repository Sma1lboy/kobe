import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Concept 3 — Task Streams
// Three parallel "task" lanes flow rightward and converge into the
// "kobe" wordmark on the right. Sells the multi-task / orchestration
// value prop: many sessions in flight, one place to drive them.

type Lane = { dot: string; label: string; color: string; offset: number }

const LANES: Lane[] = [
  { dot: "●", label: "task-1  fix login redirect", color: colors.green, offset: 0 },
  { dot: "○", label: "task-2  refactor auth service", color: colors.yellow, offset: 8 },
  { dot: "◐", label: "task-3  migrate to fastify", color: colors.magenta, offset: 16 },
]

export const TaskStreams: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const wordmarkSpring = spring({ frame: frame - 50, fps, config: { damping: 14, stiffness: 120 } })
  const wordmarkScale = interpolate(wordmarkSpring, [0, 1], [0.7, 1])
  const wordmarkOpacity = interpolate(wordmarkSpring, [0, 1], [0, 1])
  const wordmarkGlow = interpolate(wordmarkSpring, [0, 1], [0, 0.6])

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        fontFamily: monoStack,
        flexDirection: "row",
        alignItems: "center",
        padding: "0 60px",
      }}
    >
      {/* Streams column (left) */}
      <div style={{ flexGrow: 1, flexBasis: "60%", display: "flex", flexDirection: "column", gap: 36 }}>
        {LANES.map((lane) => {
          const slideIn = interpolate(frame, [lane.offset, lane.offset + 18], [-300, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
          const fadeIn = interpolate(frame, [lane.offset, lane.offset + 18], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
          return (
            <div
              key={lane.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                fontSize: 28,
                color: colors.fg,
                transform: `translateX(${slideIn}px)`,
                opacity: fadeIn,
              }}
            >
              <span style={{ color: lane.color, fontSize: 34 }}>{lane.dot}</span>
              <span>{lane.label}</span>
              <span
                style={{
                  flexGrow: 1,
                  marginLeft: 14,
                  height: 2,
                  background: `linear-gradient(to right, ${lane.color}, ${colors.muted}33)`,
                }}
              />
              <span style={{ color: colors.muted, fontSize: 22 }}>►</span>
            </div>
          )
        })}
      </div>

      {/* Wordmark (right) */}
      <div
        style={{
          flexBasis: "35%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          paddingLeft: 40,
        }}
      >
        <div
          style={{
            fontSize: 140,
            fontWeight: 700,
            letterSpacing: -4,
            color: colors.blue,
            opacity: wordmarkOpacity,
            transform: `scale(${wordmarkScale})`,
            textShadow: `0 0 ${20 + wordmarkGlow * 40}px ${colors.blue}${Math.floor(wordmarkGlow * 200)
              .toString(16)
              .padStart(2, "0")}`,
          }}
        >
          kobe
        </div>
      </div>
    </AbsoluteFill>
  )
}
