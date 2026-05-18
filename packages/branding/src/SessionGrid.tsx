import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Session Grid — multi-session parallel showcase
// Three sessions run concurrently. Each card scrolls through realistic
// Claude Code output (tool calls, diffs, bash results). A sliding window
// keeps the last MAX_VISIBLE lines in view so the card never sits empty.
// Duration: 270 frames (9 s).

const MAX_VISIBLE = 11  // lines shown at once — older ones scroll off

type Line = { text: string; color?: string; kind?: "tool" | "diff-add" | "diff-del" | "ok" | "muted" | "code" }

function line(text: string, kind?: Line["kind"]): Line {
  const colorMap: Record<NonNullable<Line["kind"]>, string> = {
    tool:     colors.cyan,
    "diff-add": colors.green,
    "diff-del": colors.red,
    ok:       colors.green,
    muted:    colors.muted,
    code:     colors.magenta,
  }
  return { text, color: kind ? colorMap[kind] : colors.fg, kind }
}

type Session = {
  title: string
  branch: string
  statusColor: string
  startFrame: number
  interval: number   // frames per line
  lines: Line[]
}

const SESSIONS: Session[] = [
  {
    title: "fix login redirect",
    branch: "feat/login-fix",
    statusColor: colors.green,
    startFrame: 8,
    interval: 9,
    lines: [
      line("▸ read_file src/auth/session.ts", "tool"),
      line("  148 lines", "muted"),
      line("▸ read_file src/routes/login.ts", "tool"),
      line("  62 lines", "muted"),
      line("Found it — missing await on line 42."),
      line("▸ edit src/auth/session.ts", "tool"),
      line("  42: - const s = getSession(req)", "diff-del"),
      line("  42: + const s = await getSession(req)", "diff-add"),
      line("  ✓ saved", "ok"),
      line("▸ bash: bun test auth", "tool"),
      line("  bun test v1.1.21", "muted"),
      line("  auth/session.test.ts", "muted"),
      line("  ✓ 14/14 tests passed", "ok"),
      line(""),
      line("Fixed. The getSession call was not"),
      line("awaited — caused redirect to fire"),
      line("before session was established."),
    ],
  },
  {
    title: "refactor auth service",
    branch: "feat/auth-refactor",
    statusColor: colors.blue,
    startFrame: 18,
    interval: 11,
    lines: [
      line("▸ bash: find src/auth -name '*.ts'", "tool"),
      line("  src/auth/jwt.ts", "muted"),
      line("  src/auth/session.ts", "muted"),
      line("  src/auth/middleware.ts", "muted"),
      line("▸ read_file src/auth/jwt.ts", "tool"),
      line("  89 lines", "muted"),
      line("Creating barrel export."),
      line("▸ write_file src/auth/index.ts", "tool"),
      line("  export * from './jwt'", "code"),
      line("  export * from './session'", "code"),
      line("  export * from './middleware'", "code"),
      line("  ✓ written", "ok"),
      line("▸ bash: grep -r 'from.*auth/'", "tool"),
      line("  8 import sites found", "muted"),
      line("▸ edit src/routes/login.ts", "tool"),
      line("  - from '../auth/jwt'", "diff-del"),
      line("  + from '../auth'", "diff-add"),
      line("▸ bash: bun tsc --noEmit", "tool"),
      line("  ✓ no errors", "ok"),
    ],
  },
  {
    title: "migrate to fastify",
    branch: "feat/fastify",
    statusColor: colors.magenta,
    startFrame: 28,
    interval: 10,
    lines: [
      line("▸ read_file src/server/index.ts", "tool"),
      line("  201 lines — express setup", "muted"),
      line("▸ bash: bun add fastify", "tool"),
      line("  + fastify@4.28.0", "ok"),
      line("▸ bash: bun remove express", "tool"),
      line("  - express@4.18.3", "diff-del"),
      line("Rewriting server entry point."),
      line("▸ write_file src/server/index.ts", "tool"),
      line("  import fastify from 'fastify'", "code"),
      line("  const app = fastify({ logger: true })", "code"),
      line("  ✓ written", "ok"),
      line("▸ bash: find src/routes -name '*.ts'", "tool"),
      line("  8 route files", "muted"),
      line("Migrating express Router → fastify plugin…"),
      line("▸ edit src/routes/login.ts", "tool"),
      line("  - router.post('/login',…)", "diff-del"),
      line("  + app.post('/login',…)", "diff-add"),
      line("  [+7 more files patched]", "muted"),
      line("▸ bash: bun run build", "tool"),
      line("  ✓ build succeeded in 1.4s", "ok"),
    ],
  },
]

export const SessionGrid: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const headerSp = spring({ frame, fps, config: { damping: 16, stiffness: 120 } })
  const headerOpacity = interpolate(headerSp, [0, 1], [0, 1])

  const tagStart = 220
  const tagSp = spring({ frame: frame - tagStart, fps, config: { damping: 16, stiffness: 120 } })
  const tagOpacity = interpolate(tagSp, [0, 1], [0, 1])
  const tagY = interpolate(tagSp, [0, 1], [10, 0])

  return (
    <AbsoluteFill
      style={{ backgroundColor: colors.bg, fontFamily: monoStack, flexDirection: "column", padding: "0 28px" }}
    >
      {/* Header */}
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          opacity: headerOpacity,
          flexShrink: 0,
        }}
      >
        <span style={{ color: colors.blue, fontSize: 17, fontWeight: 700 }}>kobe</span>
        <span style={{ color: colors.border }}>·</span>
        <span style={{ color: colors.muted, fontSize: 13 }}>3 sessions in flight</span>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, display: "flex", gap: 14, paddingBottom: 12, minHeight: 0 }}>
        {SESSIONS.map((s, i) => (
          <SessionCard key={s.title} session={s} frame={frame} fps={fps} index={i} />
        ))}
      </div>

      {/* Tagline */}
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: tagOpacity,
          transform: `translateY(${tagY}px)`,
          flexShrink: 0,
        }}
      >
        <span style={{ color: colors.muted, fontSize: 14, letterSpacing: 3 }}>
          MANY SESSIONS.{"  "}ONE SCREEN.
        </span>
      </div>
    </AbsoluteFill>
  )
}

function SessionCard({
  session,
  frame,
  fps,
}: {
  session: Session
  frame: number
  fps: number
  index: number
}) {
  const cardSp = spring({ frame: frame - session.startFrame, fps, config: { damping: 16, stiffness: 130 } })
  const cardOpacity = interpolate(cardSp, [0, 1], [0, 1])
  const cardY = interpolate(cardSp, [0, 1], [20, 0])

  const contentStart = session.startFrame + 12
  const linesVisible = Math.max(0, Math.floor((frame - contentStart) / session.interval))
  const isDone = linesVisible >= session.lines.length

  // Sliding window: always show the last MAX_VISIBLE lines
  const sliceEnd = Math.min(linesVisible, session.lines.length)
  const sliceStart = Math.max(0, sliceEnd - MAX_VISIBLE)
  const visibleLines = session.lines.slice(sliceStart, sliceEnd)

  const cursorOn = Math.floor(frame / 8) % 2 === 0

  // Status label
  const statusLabel = isDone ? "done" : "running"
  const statusColor = isDone ? colors.muted : session.statusColor

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: colors.panel,
        border: `1px solid ${isDone ? colors.border : session.statusColor + "44"}`,
        borderRadius: 8,
        overflow: "hidden",
        opacity: cardOpacity,
        transform: `translateY(${cardY}px)`,
        transition: "border-color 0.3s",
      }}
    >
      {/* Card header */}
      <div
        style={{
          padding: "9px 13px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: statusColor, flexShrink: 0,
              boxShadow: isDone ? "none" : `0 0 6px ${session.statusColor}`,
            }}
          />
          <span style={{ color: colors.fg, fontSize: 13, fontWeight: 700, flex: 1 }}>
            {session.title}
          </span>
          <span style={{ color: statusColor, fontSize: 11 }}>{statusLabel}</span>
        </div>
        <div style={{ color: colors.muted, fontSize: 11, paddingLeft: 15, marginTop: 3 }}>
          ⎇{"  "}{session.branch}
        </div>
      </div>

      {/* Content — scrolling window */}
      <div
        style={{
          flex: 1,
          padding: "9px 13px",
          fontSize: 11.5,
          lineHeight: 1.65,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",  // anchor to bottom so new lines push up
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* Fade indicator when older lines have scrolled out */}
          {sliceStart > 0 && (
            <div style={{ color: colors.border, fontSize: 10, marginBottom: 4, letterSpacing: 1 }}>
              ↑ {sliceStart} earlier lines
            </div>
          )}
          {visibleLines.map((ln, li) => (
            <div
              key={sliceStart + li}
              style={{ color: ln.color ?? colors.fg, whiteSpace: "pre", minHeight: "1.65em" }}
            >
              {ln.text || " "}
            </div>
          ))}
          {/* Streaming cursor */}
          {!isDone && linesVisible > 0 && (
            <div style={{ color: session.statusColor, opacity: cursorOn ? 1 : 0, minHeight: "1.65em" }}>
              ▌
            </div>
          )}
          {/* Done checkmark */}
          {isDone && (
            <div style={{ color: colors.green, fontSize: 11, marginTop: 6, opacity: 0.7 }}>
              ✓ complete
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
