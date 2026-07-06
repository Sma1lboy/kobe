import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"


const K_PATTERN: ReadonlyArray<ReadonlyArray<0 | 1>> = [
  [1, 0, 0, 0, 1],
  [1, 0, 0, 1, 0],
  [1, 0, 1, 0, 0],
  [1, 1, 0, 0, 0],
  [1, 0, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 0, 1],
]

const PIXEL = 56
const GAP = 4
const COLS = K_PATTERN[0].length
const ROWS = K_PATTERN.length

export const GlyphK: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const tileSpring = spring({ frame, fps, config: { damping: 18, stiffness: 110 } })
  const tileScale = interpolate(tileSpring, [0, 1], [0.92, 1])
  const tileOpacity = interpolate(tileSpring, [0, 1], [0, 1])

  const glow = interpolate(frame % 90, [0, 45, 90], [0.35, 0.7, 0.35])

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bgSoft,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: monoStack,
      }}
    >
      <div
        style={{
          width: 640,
          height: 640,
          borderRadius: 144,
          background: `linear-gradient(160deg, ${colors.panel}, ${colors.bg})`,
          boxShadow: [
            "0 30px 80px rgba(0,0,0,0.5)",
            `inset 0 2px 0 rgba(255,255,255,0.05)`,
            `inset 0 -2px 0 rgba(0,0,0,0.4)`,
          ].join(", "),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${tileScale})`,
          opacity: tileOpacity,
          position: "relative",
          overflow: "hidden",
        }}
      >
        { }
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(circle at 50% 50%, ${colors.blue}${Math.floor(glow * 80)
              .toString(16)
              .padStart(2, "0")}, transparent 55%)`,
            pointerEvents: "none",
          }}
        />

        { }
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${COLS}, ${PIXEL}px)`,
            gridTemplateRows: `repeat(${ROWS}, ${PIXEL}px)`,
            gap: GAP,
            position: "relative",
          }}
        >
          {K_PATTERN.flatMap((row, rIdx) =>
            row.map((cell, cIdx) => {
              if (cell === 0) {
                return <div key={`${rIdx}-${cIdx}`} />
              }
              const start = 8 + rIdx * 4
              const end = start + 10
              const reveal = interpolate(frame, [start, end], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
              return (
                <div
                  key={`${rIdx}-${cIdx}`}
                  style={{
                    background: colors.fg,
                    borderRadius: 6,
                    opacity: reveal,
                    transform: `scale(${0.6 + reveal * 0.4})`,
                    boxShadow: `0 0 ${8 + glow * 14}px ${colors.blue}80`,
                  }}
                />
              )
            }),
          )}
        </div>
      </div>
    </AbsoluteFill>
  )
}
