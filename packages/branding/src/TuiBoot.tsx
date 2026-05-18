import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// TUI Boot — product demo
// Cold start: `$ kobe` types, spinner counts down, then the 5-pane layout
// assembles pane by pane with live-looking content. Best for README hero.

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function typeText(text: string, frame: number, startFrame: number, perChar = 4): string {
  const chars = Math.max(0, Math.floor((frame - startFrame) / perChar))
  return text.slice(0, Math.min(chars, text.length))
}

// Pane definitions — each reveals at a different time
type PaneSpec = {
  id: string
  label: string
  startFrame: number
  color: string
  lines: string[]
}

const PANES: PaneSpec[] = [
  {
    id: "tasks",
    label: "TASKS",
    startFrame: 55,
    color: colors.muted,
    lines: [
      "● fix login redirect",
      "  ─────────────────",
      "○ refactor auth svc",
      "  ─────────────────",
      "○ migrate to fastify",
      "",
      "  3 tasks / 1 active",
    ],
  },
  {
    id: "workspace",
    label: "WORKSPACE  [chat] [files]",
    startFrame: 65,
    color: colors.fg,
    lines: [
      "  ╭─ assistant ──────────────╮",
      "  │ I'll start by reading   │",
      "  │ the current auth flow…  │",
      "  ╰────────────────────────╯",
      "",
      "  ╭─ tool: read ────────────╮",
      "  │ src/auth/session.ts    │",
      "  ╰────────────────────────╯",
    ],
  },
  {
    id: "files",
    label: "FILES",
    startFrame: 75,
    color: colors.muted,
    lines: [
      "▸ src/",
      "  ▸ auth/",
      "    session.ts",
      "    middleware.ts",
      "  ▸ routes/",
      "    login.ts",
      "  index.ts",
    ],
  },
  {
    id: "terminal",
    label: "TERMINAL",
    startFrame: 85,
    color: colors.green,
    lines: ["$ bun run dev", "", "  listening on :3000", "  watching src/…", "", "$▌"],
  },
]

export const TuiBoot: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Phase 1: type `$ kobe` (frames 0–30)
  const prompt = typeText("$ kobe", frame, 0, 3)
  const cursorOn = Math.floor(frame / 10) % 2 === 0

  // Phase 2: spinner (frames 30–52)
  const showSpinner = frame >= 30 && frame < 52
  const spinnerChar = SPINNER_FRAMES[Math.floor(frame / 3) % SPINNER_FRAMES.length]

  // Phase 3: header bar reveals (frame 50)
  const headerSpring = spring({ frame: frame - 50, fps, config: { damping: 16, stiffness: 150 } })
  const headerOpacity = interpolate(headerSpring, [0, 1], [0, 1])
  const headerY = interpolate(headerSpring, [0, 1], [-12, 0])

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        fontFamily: monoStack,
        flexDirection: "column",
      }}
    >
      {/* ── Header bar ── */}
      {frame >= 50 && (
        <div
          style={{
            height: 36,
            background: colors.panel,
            borderBottom: `1px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            paddingLeft: 16,
            gap: 24,
            opacity: headerOpacity,
            transform: `translateY(${headerY}px)`,
            fontSize: 13,
            color: colors.muted,
            flexShrink: 0,
          }}
        >
          <span style={{ color: colors.blue, fontWeight: 700 }}>kobe</span>
          <span>v0.5.26</span>
          <span style={{ marginLeft: "auto", marginRight: 16, color: colors.green }}>● claude-opus-4</span>
        </div>
      )}

      {/* ── Boot phase (before layout) ── */}
      {frame < 50 && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div style={{ fontSize: 22, color: colors.fg }}>
            {prompt}
            {frame < 30 && (
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 18,
                  background: colors.green,
                  marginLeft: 4,
                  verticalAlign: "middle",
                  opacity: cursorOn ? 1 : 0,
                }}
              />
            )}
          </div>
          {showSpinner && (
            <div style={{ fontSize: 18, color: colors.blue }}>
              {spinnerChar} starting kobe daemon…
            </div>
          )}
        </div>
      )}

      {/* ── Main 3-column layout ── */}
      {frame >= 50 && (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Sidebar */}
          <PaneColumn spec={PANES[0]} frame={frame} fps={fps} width={220} />

          {/* Divider */}
          <div style={{ width: 1, background: colors.border, flexShrink: 0 }} />

          {/* Workspace */}
          <PaneColumn spec={PANES[1]} frame={frame} fps={fps} flex={1} />

          {/* Divider */}
          <div style={{ width: 1, background: colors.border, flexShrink: 0 }} />

          {/* Right column: files + terminal stacked */}
          <div style={{ width: 260, display: "flex", flexDirection: "column" }}>
            <PaneColumn spec={PANES[2]} frame={frame} fps={fps} flex={1} />
            <div style={{ height: 1, background: colors.border }} />
            <PaneColumn spec={PANES[3]} frame={frame} fps={fps} flex={1} />
          </div>
        </div>
      )}

      {/* ── Status bar ── */}
      {frame >= 95 && (
        <StatusBar frame={frame} fps={fps} />
      )}
    </AbsoluteFill>
  )
}

// ── Sub-components ──────────────────────────────────────────────────

function PaneColumn({
  spec,
  frame,
  fps,
  width,
  flex,
}: {
  spec: PaneSpec
  frame: number
  fps: number
  width?: number
  flex?: number
}) {
  const paneSpring = spring({ frame: frame - spec.startFrame, fps, config: { damping: 18, stiffness: 130 } })
  const paneOpacity = interpolate(paneSpring, [0, 1], [0, 1])
  const paneY = interpolate(paneSpring, [0, 1], [8, 0])

  const linesVisible = Math.max(0, Math.floor((frame - spec.startFrame - 8) / 5))

  return (
    <div
      style={{
        width,
        flex,
        display: "flex",
        flexDirection: "column",
        opacity: paneOpacity,
        transform: `translateY(${paneY}px)`,
        overflow: "hidden",
      }}
    >
      {/* Pane header */}
      <div
        style={{
          height: 28,
          borderBottom: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
          fontSize: 11,
          fontWeight: 700,
          color: colors.muted,
          letterSpacing: 1,
          flexShrink: 0,
        }}
      >
        {spec.label}
      </div>

      {/* Pane content */}
      <div
        style={{
          flex: 1,
          padding: "10px 14px",
          fontSize: 13,
          lineHeight: 1.6,
          color: spec.color,
          overflow: "hidden",
        }}
      >
        {spec.lines.slice(0, linesVisible).map((line, i) => (
          <div key={i} style={{ whiteSpace: "pre" }}>
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusBar({ frame, fps }: { frame: number; fps: number }) {
  const barSpring = spring({ frame: frame - 95, fps, config: { damping: 16, stiffness: 140 } })
  const barOpacity = interpolate(barSpring, [0, 1], [0, 1])
  const barY = interpolate(barSpring, [0, 1], [10, 0])

  return (
    <div
      style={{
        height: 28,
        background: colors.panel,
        borderTop: `1px solid ${colors.border}`,
        display: "flex",
        alignItems: "center",
        paddingLeft: 14,
        paddingRight: 14,
        gap: 20,
        fontSize: 12,
        color: colors.muted,
        flexShrink: 0,
        opacity: barOpacity,
        transform: `translateY(${barY}px)`,
      }}
    >
      <span style={{ color: colors.blue }}>⎇  feat/login-fix</span>
      <span>3 tasks</span>
      <span style={{ marginLeft: "auto" }}>ctx 12k / 200k</span>
      <span style={{ color: colors.green }}>●</span>
    </div>
  )
}
