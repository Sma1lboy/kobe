import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono"
import { loadFont as loadSans } from "@remotion/google-fonts/NotoSansSC"
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./theme"

loadMono("normal", { weights: ["400", "700"] })
const { fontFamily: sansSC } = loadSans("normal", { weights: ["400", "700"] })

export const sansStack = `${sansSC}, ${monoStack}`

// Shared vertical-frame chrome: warm-black fill + the voiceover line as a
// bottom caption bar (there is no audio track — the caption IS the narration).
export const SceneShell: React.FC<{ caption: string; children: React.ReactNode }> = ({ caption, children }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const captionIn = interpolate(frame, [0, 0.4 * fps], [0, 1], {
    extrapolateRight: "clamp",
  })
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: colors.bg,
        fontFamily: sansStack,
        overflow: "hidden",
      }}
    >
      {children}
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 140,
          textAlign: "center",
          color: colors.fg,
          fontSize: 44,
          lineHeight: 1.5,
          opacity: captionIn,
          transform: `translateY(${(1 - captionIn) * 24}px)`,
        }}
      >
        {caption}
      </div>
    </div>
  )
}

// The wordmark: lowercase mono "kobe" with the brand-defining terracotta "o".
export const Wordmark: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <span style={{ fontFamily: monoStack, fontWeight: 700, fontSize: size, color: colors.fg, ...style }}>
    k<span style={{ color: colors.blue }}>o</span>be
  </span>
)

// A mock terminal/chat window card (title bar + content lines placeholder).
export const WindowCard: React.FC<{
  width: number
  height: number
  title: string
  children?: React.ReactNode
  style?: React.CSSProperties
}> = ({ width, height, title, children, style }) => (
  <div
    style={{
      width,
      height,
      borderRadius: 14,
      border: `2px solid ${colors.border}`,
      backgroundColor: colors.bgSoft,
      overflow: "hidden",
      ...style,
    }}
  >
    <div
      style={{
        height: 44,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 18px",
        backgroundColor: colors.panel,
        color: colors.muted,
        fontFamily: monoStack,
        fontSize: 20,
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.red }} />
      <span style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.yellow }} />
      <span style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.green }} />
      <span style={{ marginLeft: 8, whiteSpace: "nowrap" }}>{title}</span>
    </div>
    <div style={{ padding: 16 }}>{children}</div>
  </div>
)

// Placeholder content rows for a mock window: muted bars of varying width.
export const ContentBars: React.FC<{ rows: number; seedWidths: number[] }> = ({ rows, seedWidths }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {Array.from({ length: rows }, (_, i) => (
      <div
        key={i}
        style={{
          height: 14,
          width: `${seedWidths[i % seedWidths.length]}%`,
          borderRadius: 7,
          backgroundColor: i % 4 === 2 ? colors.panel : colors.border,
        }}
      />
    ))}
  </div>
)
