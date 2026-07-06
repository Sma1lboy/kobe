import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion"
import { colors, monoStack } from "./colors"


const ROWS = [
  "┌──────────────────────────────────────────────┐",
  "│ kobe                                         │",
  "├────────┬────────────────────────┬────────────┤",
  "│ TASKS  │ WORKSPACE              │ FILES      │",
  "│        │                        │            │",
  "│ ●      │                        │ ─ ─ ─      │",
  "│ ○      │       ▌ kobe ▐         │ ─ ─        │",
  "│ ○      │                        │            │",
  "│        │                        ├────────────┤",
  "│        │                        │ TERMINAL   │",
  "│        │                        │ $          │",
  "└────────┴────────────────────────┴────────────┘",
]

export const PaneGrid: React.FC = () => {
  const frame = useCurrentFrame()
  const lineDuration = 8

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: monoStack,
      }}
    >
      <pre
        style={{
          margin: 0,
          fontSize: 28,
          lineHeight: 1.15,
          color: colors.border,
          letterSpacing: 0,
        }}
      >
        {ROWS.map((line, i) => {
          const start = i * 2
          const reveal = interpolate(frame, [start, start + lineDuration], [0, line.length], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
          const visible = line.slice(0, Math.floor(reveal))

          const isWordmark = line.includes("kobe") && i === 6
          const wordmarkOpacity = isWordmark ? interpolate(frame, [70, 90], [0, 1], { extrapolateRight: "clamp" }) : 1

          if (isWordmark) {
            const before = visible.split("kobe")[0] ?? visible
            const hasWord = visible.includes("kobe")
            return (
              <div key={i}>
                <span style={{ color: colors.border }}>{before}</span>
                {hasWord ? (
                  <>
                    <span style={{ color: colors.blue, opacity: wordmarkOpacity }}>kobe</span>
                    <span style={{ color: colors.border }}>{visible.slice(before.length + 4)}</span>
                  </>
                ) : null}
              </div>
            )
          }

          return (
            <div key={i} style={{ color: colors.border }}>
              {visible}
            </div>
          )
        })}
      </pre>
    </AbsoluteFill>
  )
}
