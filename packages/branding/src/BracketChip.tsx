import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Concept 1 — Bracket Chip [ kobe ]
// On-brand for the agent-deck "[Tab] label" hotkey grammar that runs through
// kobe's UI. Brackets snap in, "kobe" types in, the cursor blinks.
// Reads as a button you can press — that's the point.

export const BracketChip: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const leftBracket = spring({ frame: frame - 4, fps, config: { damping: 12, stiffness: 180 } })
  const rightBracket = spring({ frame: frame - 10, fps, config: { damping: 12, stiffness: 180 } })

  const word = "kobe"
  const typeStart = 22
  const perChar = 5
  const chars = Math.max(0, Math.floor((frame - typeStart) / perChar))
  const typed = word.slice(0, Math.min(chars, word.length))

  const cursorOn = Math.floor(frame / 12) % 2 === 0 && frame > typeStart

  const leftX = interpolate(leftBracket, [0, 1], [-60, 0])
  const rightX = interpolate(rightBracket, [0, 1], [60, 0])
  const leftOpacity = interpolate(leftBracket, [0, 1], [0, 1])
  const rightOpacity = interpolate(rightBracket, [0, 1], [0, 1])

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: monoStack,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          fontSize: 180,
          fontWeight: 700,
          letterSpacing: -4,
          color: colors.fg,
        }}
      >
        <span style={{ color: colors.blue, transform: `translateX(${leftX}px)`, opacity: leftOpacity }}>[</span>
        <span style={{ minWidth: 480, textAlign: "center", display: "inline-block" }}>
          <span>{typed}</span>
          <span
            style={{
              display: "inline-block",
              width: 14,
              height: 140,
              marginLeft: 8,
              verticalAlign: "middle",
              background: colors.green,
              opacity: cursorOn ? 1 : 0,
            }}
          />
        </span>
        <span style={{ color: colors.blue, transform: `translateX(${rightX}px)`, opacity: rightOpacity }}>]</span>
      </div>
      <div style={{ marginTop: 32, color: colors.muted, fontSize: 22, letterSpacing: 4 }}>
        TUI ORCHESTRATOR FOR CLAUDE CODE
      </div>
    </AbsoluteFill>
  )
}
