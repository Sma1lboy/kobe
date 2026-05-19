import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Session Grid v2 — macOS terminal window style
// Each session is a terminal window with proper chrome: traffic lights,
// title bar, scrolling content. Lines fill from the top naturally.
// Duration: 270 frames (9 s).

const MAX_VISIBLE = 13

type Line = {
  text: string
  color?: string
}

function t(text: string, color?: string): Line {
  return { text, color }
}

type Session = {
  title: string
  branch: string
  dotColor: string     // terminal window accent
  startFrame: number
  interval: number
  lines: Line[]
}

const SESSIONS: Session[] = [
  {
    title: "fix login redirect",
    branch: "feat/login-fix",
    dotColor: colors.green,
    startFrame: 6,
    interval: 8,
    lines: [
      t("$ read src/auth/session.ts", colors.cyan),
      t("  148 lines"),
      t("$ read src/routes/login.ts", colors.cyan),
      t("  62 lines"),
      t(""),
      t("Found it. Missing await on line 42.", colors.yellow),
      t(""),
      t("$ edit src/auth/session.ts", colors.cyan),
      t("  42: - const s = getSession(req)", colors.red),
      t("  42: + const s = await getSession(req)", colors.green),
      t("  ✓ saved", colors.green),
      t(""),
      t("$ bun test src/auth", colors.cyan),
      t("  bun test v1.1.21", colors.muted),
      t("  auth/session.test.ts", colors.muted),
      t("  ✓ 14 / 14 tests passed", colors.green),
      t(""),
      t("Done. getSession was not awaited —", colors.fg),
      t("redirect fired before session existed.", colors.fg),
    ],
  },
  {
    title: "refactor auth service",
    branch: "feat/auth-refactor",
    dotColor: colors.blue,
    startFrame: 16,
    interval: 10,
    lines: [
      t("$ find src/auth -name '*.ts'", colors.cyan),
      t("  src/auth/jwt.ts"),
      t("  src/auth/session.ts"),
      t("  src/auth/middleware.ts"),
      t(""),
      t("$ read src/auth/jwt.ts", colors.cyan),
      t("  89 lines"),
      t(""),
      t("Creating barrel export.", colors.yellow),
      t(""),
      t("$ write src/auth/index.ts", colors.cyan),
      t("  export * from './jwt'", colors.magenta),
      t("  export * from './session'", colors.magenta),
      t("  export * from './middleware'", colors.magenta),
      t("  ✓ written", colors.green),
      t(""),
      t("$ grep -r \"from.*auth/\" src/routes", colors.cyan),
      t("  8 import sites → updating…", colors.muted),
      t("  ✓ 8 files patched", colors.green),
      t(""),
      t("$ bun tsc --noEmit", colors.cyan),
      t("  ✓ no errors", colors.green),
    ],
  },
  {
    title: "migrate to fastify",
    branch: "feat/fastify",
    dotColor: colors.magenta,
    startFrame: 26,
    interval: 9,
    lines: [
      t("$ read src/server/index.ts", colors.cyan),
      t("  201 lines  (express)"),
      t(""),
      t("$ bun add fastify", colors.cyan),
      t("  + fastify@4.28.0", colors.green),
      t("$ bun remove express", colors.cyan),
      t("  - express@4.18.3", colors.red),
      t(""),
      t("Rewriting server entry point.", colors.yellow),
      t(""),
      t("$ write src/server/index.ts", colors.cyan),
      t("  import fastify from 'fastify'", colors.magenta),
      t("  const app = fastify({ logger: true })", colors.magenta),
      t("  ✓ written", colors.green),
      t(""),
      t("$ find src/routes -name '*.ts'", colors.cyan),
      t("  8 route files"),
      t("  patching router.X → app.X …", colors.muted),
      t("  ✓ 8 files patched", colors.green),
      t(""),
      t("$ bun run build", colors.cyan),
      t("  ✓ built in 1.4 s", colors.green),
    ],
  },
]

export const SessionGrid: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const headerSp = spring({ frame, fps, config: { damping: 16, stiffness: 120 } })

  const tagSp = spring({ frame: frame - 225, fps, config: { damping: 16, stiffness: 120 } })
  const tagOp = interpolate(tagSp, [0, 1], [0, 1])
  const tagY  = interpolate(tagSp, [0, 1], [10, 0])

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0D0D0C",   // slightly darker than colors.bg for contrast
        fontFamily: monoStack,
        flexDirection: "column",
        padding: "12px 20px 10px",
      }}
    >
      {/* Top label */}
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          opacity: interpolate(headerSp, [0, 1], [0, 1]),
          flexShrink: 0,
        }}
      >
        <span style={{ color: colors.blue, fontSize: 16, fontWeight: 700, letterSpacing: 0.5 }}>kobe</span>
        <span style={{ color: "#444", fontSize: 14 }}>·</span>
        <span style={{ color: colors.muted, fontSize: 13 }}>3 sessions in flight</span>
      </div>

      {/* Windows row */}
      <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
        {SESSIONS.map((s, i) => (
          <TerminalWindow key={s.title} session={s} frame={frame} fps={fps} index={i} />
        ))}
      </div>

      {/* Tagline */}
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: tagOp,
          transform: `translateY(${tagY}px)`,
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#555", fontSize: 13, letterSpacing: 3 }}>
          MANY SESSIONS.{"  "}ONE SCREEN.
        </span>
      </div>
    </AbsoluteFill>
  )
}

function TerminalWindow({
  session,
  frame,
  fps,
}: {
  session: Session
  frame: number
  fps: number
  index: number
}) {
  const winSp = spring({ frame: frame - session.startFrame, fps, config: { damping: 15, stiffness: 120 } })
  const winOp = interpolate(winSp, [0, 1], [0, 1])
  const winY  = interpolate(winSp, [0, 1], [24, 0])

  const contentStart = session.startFrame + 10
  const linesVisible = Math.max(0, Math.floor((frame - contentStart) / session.interval))
  const isDone  = linesVisible >= session.lines.length

  const sliceEnd   = Math.min(linesVisible, session.lines.length)
  const sliceStart = Math.max(0, sliceEnd - MAX_VISIBLE)
  const visible    = session.lines.slice(sliceStart, sliceEnd)

  const cursorOn = Math.floor(frame / 7) % 2 === 0

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        borderRadius: 10,
        overflow: "hidden",
        opacity: winOp,
        transform: `translateY(${winY}px)`,
        // macOS terminal window shadow
        boxShadow: `
          0 0 0 1px rgba(255,255,255,0.08),
          0 2px 4px rgba(0,0,0,0.4),
          0 8px 24px rgba(0,0,0,0.5)
        `,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: 34,
          background: "linear-gradient(to bottom, #2C2C2E, #252523)",
          borderBottom: "1px solid rgba(0,0,0,0.4)",
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
          paddingRight: 12,
          gap: 7,
          flexShrink: 0,
          position: "relative",
        }}
      >
        {/* Traffic lights */}
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#FF5F57", flexShrink: 0 }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#FEBC2E", flexShrink: 0 }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28C840", flexShrink: 0 }} />

        {/* Title */}
        <span
          style={{
            position: "absolute",
            left: 0, right: 0,
            textAlign: "center",
            color: "rgba(255,255,255,0.55)",
            fontSize: 12,
            fontFamily: monoStack,
            letterSpacing: 0.2,
            pointerEvents: "none",
          }}
        >
          {session.title}
        </span>
      </div>

      {/* Branch bar */}
      <div
        style={{
          height: 24,
          background: "#1A1A18",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span style={{ color: session.dotColor, fontSize: 10 }}>⎇</span>
        <span style={{ color: "#555", fontSize: 11 }}>{session.branch}</span>
        <span
          style={{
            marginLeft: "auto",
            marginRight: 10,
            fontSize: 10,
            color: isDone ? "#555" : session.dotColor,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {!isDone && (
            <span
              style={{
                width: 6, height: 6, borderRadius: "50%",
                background: session.dotColor,
                display: "inline-block",
                boxShadow: `0 0 5px ${session.dotColor}`,
              }}
            />
          )}
          {isDone ? "done" : "running"}
        </span>
      </div>

      {/* Terminal content */}
      <div
        style={{
          flex: 1,
          background: "#111110",
          padding: "10px 14px 10px",
          fontSize: 12,
          lineHeight: 1.65,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {sliceStart > 0 && (
          <div style={{ color: "#333", fontSize: 10, marginBottom: 4 }}>
            ↑ {sliceStart} earlier lines
          </div>
        )}
        {visible.map((ln, li) => (
          <div
            key={sliceStart + li}
            style={{
              color: ln.color ?? colors.fg,
              whiteSpace: "pre",
              minHeight: "1.65em",
            }}
          >
            {ln.text || " "}
          </div>
        ))}
        {!isDone && linesVisible > 0 && (
          <div style={{ color: session.dotColor, opacity: cursorOn ? 1 : 0, minHeight: "1.65em" }}>
            ▌
          </div>
        )}
        {isDone && (
          <div style={{ color: "#3A3A38", fontSize: 11, marginTop: 8 }}>
            — session complete —
          </div>
        )}
      </div>
    </div>
  )
}
