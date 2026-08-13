import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Concept 1 — Bracket Chip [ rove ]
// On-brand for the agent-deck "[Tab] label" hotkey grammar that runs through
// Rove's UI. Brackets snap in, "rove" types in, the cursor blinks.
// Reads as a button you can press — that's the point.

export const BracketChip: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const leftBracket = spring({ frame: frame - 4, fps, config: { damping: 12, stiffness: 180 } })
  const rightBracket = spring({ frame: frame - 10, fps, config: { damping: 12, stiffness: 180 } })

  const word = "rove"
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
          gap: 18,
          fontSize: 120,
          fontWeight: 700,
          letterSpacing: -3,
          color: colors.fg,
        }}
      >
        <span style={{ color: colors.blue, transform: `translateX(${leftX}px)`, opacity: leftOpacity }}>[</span>
        <span style={{ minWidth: 320, textAlign: "center", display: "inline-block" }}>
          <span>{typed}</span>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 92,
              marginLeft: 6,
              verticalAlign: "middle",
              background: colors.green,
              opacity: cursorOn ? 1 : 0,
            }}
          />
        </span>
        <span style={{ color: colors.blue, transform: `translateX(${rightX}px)`, opacity: rightOpacity }}>]</span>
      </div>
      <div style={{ marginTop: 20, color: colors.muted, fontSize: 20, letterSpacing: 5 }}>
        THE AGENT MULTIPLEXER IN YOUR SHELL
      </div>
      <div style={{ marginTop: 10, color: colors.muted, fontSize: 14, letterSpacing: 3, opacity: 0.7 }}>
        CLAUDE · CODEX · COPILOT · YOUR OWN
      </div>
    </AbsoluteFill>
  )
}
