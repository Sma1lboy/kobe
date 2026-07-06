import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Concept 4 — Glyph K (app-icon shape, Conductor-style pixel tile)
// Rounded-square dark tile + a chunky pixel-grid "K". Mirrors the Conductor
// app icon's grammar: blocky letterform sitting in a tinted rounded tile,
// reads as a real macOS / iOS / Linux app icon. Pixels reveal row-by-row
// on intro; tile holds a subtle inner glow. Survives the rename — swap
// the K_PATTERN cells for whatever first letter the new name gives us.

// 7×5 pixel K. Left column is the vertical bar; the two diagonals meet
// the bar at row 3 (the middle), forming a cleanly readable "K".
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

  // Tile entrance.
  const tileSpring = spring({ frame, fps, config: { damping: 18, stiffness: 110 } })
  const tileScale = interpolate(tileSpring, [0, 1], [0.92, 1])
  const tileOpacity = interpolate(tileSpring, [0, 1], [0, 1])

  // Continuous subtle pulse on the glow once tile has settled.
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
            // Outer drop shadow grounds the tile.
            "0 30px 80px rgba(0,0,0,0.5)",
            // Inner highlight + inner shadow for the dimensional tile feel.
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
        {/* Soft halo behind the glyph */}
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

        {/* Pixel grid K */}
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
