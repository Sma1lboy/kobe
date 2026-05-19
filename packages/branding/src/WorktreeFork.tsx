import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Worktree Fork v2
// Timeline:
//  0–25:  main branch draws, commit dots pop in
// 25–42:  fork dot pulses
// 42–75:  feature branch (Bezier → horizontal), commits follow
// 75–80:  horizontal divider slides in
// 80–115: three component rows slide in from left (staggered)
// 115–170: equation assembles token-by-token
// 170–210: Task chip pulses

function clamp(t: number) {
  return Math.min(1, Math.max(0, t))
}

const MAIN_Y = 130
const FEAT_Y = 255
const FORK_X = 250
const LINE_LEFT = 60
const LINE_RIGHT = 1140
const CURVE_CTRL_X = 395   // Bezier horizontal end

// Commits on main
const MAIN_COMMITS = [150, 300, 450, 600]
// Commits on feature (x positions)
const FEAT_COMMITS = [510, 660, 810, 960, 1110]

// Three component rows
const ROWS = [
  { icon: "⎇", title: "branch",   detail: "feat/login-fix",           color: colors.green,   start: 80 },
  { icon: "⊞", title: "worktree", detail: ".claude/worktrees/login-fix", color: colors.magenta, start: 96 },
  { icon: "◉", title: "session",  detail: "claude-opus-4  ·  running", color: colors.blue,    start: 112 },
]

const ROW_H = 52
const ROW_GAP = 6
const ROWS_TOP = 305   // y where first row starts
const DIVIDER_Y = 293

const EQ_PARTS = [
  { text: "branch",   color: colors.green,   start: 115 },
  { text: "  +  ",   color: colors.muted,   start: 122 },
  { text: "worktree", color: colors.magenta, start: 127 },
  { text: "  +  ",   color: colors.muted,   start: 134 },
  { text: "session",  color: colors.blue,    start: 139 },
  { text: "   =   ",  color: colors.muted,   start: 146 },
  { text: "Task",     color: colors.yellow,  start: 153 },
]

export const WorktreeFork: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // ── main branch ──────────────────────────────────────────────────
  const mainP = clamp(interpolate(frame, [0, 25], [0, 1]))
  const mainRight = LINE_LEFT + mainP * (LINE_RIGHT - LINE_LEFT)

  // ── fork dot ─────────────────────────────────────────────────────
  const forkSp  = spring({ frame: frame - 25, fps, config: { damping: 12, stiffness: 230 } })
  const forkR   = interpolate(forkSp, [0, 1], [0, 11])
  const forkOp  = interpolate(forkSp, [0, 1], [0, 1])
  const rippleR = clamp(interpolate(frame, [25, 50], [0, 30]))
  const rippleO = clamp(interpolate(frame, [25, 50], [0.8, 0]))

  // ── feature branch ───────────────────────────────────────────────
  // Approximate total path length for dash trick
  const CURVE_LEN = 210
  const HORIZ_LEN = LINE_RIGHT - CURVE_CTRL_X   // 745
  const totalLen  = CURVE_LEN + HORIZ_LEN
  const drawn     = clamp(interpolate(frame, [42, 75], [0, 1])) * totalLen
  const dashOff   = totalLen - drawn

  // ── horizontal divider ───────────────────────────────────────────
  const divSp    = spring({ frame: frame - 75, fps, config: { damping: 18, stiffness: 160 } })
  const divWidth = interpolate(divSp, [0, 1], [0, LINE_RIGHT - LINE_LEFT])
  const divOp    = interpolate(divSp, [0, 1], [0, 1])

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, fontFamily: monoStack }}>
      {/* ── SVG: git graph ── */}
      <svg
        width={1200} height={630}
        viewBox="0 0 1200 630"
        style={{ position: "absolute", inset: 0 }}
      >
        {/* Faint horizon guide */}
        <line x1={40} y1={MAIN_Y} x2={1160} y2={MAIN_Y}
          stroke={colors.border} strokeWidth={1} strokeDasharray="3 9" opacity={0.25} />
        <line x1={40} y1={FEAT_Y} x2={1160} y2={FEAT_Y}
          stroke={colors.border} strokeWidth={1} strokeDasharray="3 9" opacity={0.25} />

        {/* main line */}
        <line x1={LINE_LEFT} y1={MAIN_Y} x2={mainRight} y2={MAIN_Y}
          stroke={colors.muted} strokeWidth={2.5} strokeLinecap="round" />

        {/* main label */}
        <text x={LINE_LEFT} y={MAIN_Y - 20}
          fill={colors.muted} fontSize={13} fontFamily={monoStack} fontWeight={600}
          opacity={clamp(interpolate(frame, [3, 12], [0, 1]))}>
          main
        </text>

        {/* main commits */}
        {MAIN_COMMITS.map((cx) =>
          cx < mainRight - 15 ? (
            <circle key={cx} cx={cx} cy={MAIN_Y} r={6}
              fill={colors.bg} stroke={colors.muted} strokeWidth={2}
              opacity={clamp(interpolate(frame, [(cx / LINE_RIGHT) * 25, (cx / LINE_RIGHT) * 25 + 5], [0, 1]))} />
          ) : null,
        )}

        {/* ripple + fork dot */}
        <circle cx={FORK_X} cy={MAIN_Y} r={rippleR}
          fill="none" stroke={colors.blue} strokeWidth={1.5} opacity={rippleO} />
        <circle cx={FORK_X} cy={MAIN_Y} r={forkR}
          fill={colors.blue} opacity={forkOp}
          style={{ filter: `drop-shadow(0 0 10px ${colors.blue})` }} />

        {/* feature branch — Bezier + horizontal via dashoffset */}
        {drawn > 0 && (
          <path
            d={`M ${FORK_X} ${MAIN_Y}
                C ${FORK_X} ${FEAT_Y - 50} ${CURVE_CTRL_X - 60} ${FEAT_Y} ${CURVE_CTRL_X} ${FEAT_Y}
                L ${LINE_RIGHT} ${FEAT_Y}`}
            stroke={colors.blue} strokeWidth={2.5} strokeLinecap="round" fill="none"
            strokeDasharray={`${totalLen} ${totalLen}`}
            strokeDashoffset={dashOff}
            style={{ filter: `drop-shadow(0 0 5px ${colors.blue}55)` }}
          />
        )}

        {/* feat label */}
        {drawn > CURVE_LEN * 0.6 && (
          <text x={CURVE_CTRL_X + 14} y={FEAT_Y - 16}
            fill={colors.blue} fontSize={12} fontFamily={monoStack}
            opacity={clamp(interpolate(frame, [62, 72], [0, 1]))}>
            feat/login-fix
          </text>
        )}

        {/* feature commits */}
        {FEAT_COMMITS.map((cx, i) => {
          const branchHorizEnd = CURVE_CTRL_X + ((frame - 42) / (75 - 42)) * (LINE_RIGHT - CURVE_CTRL_X)
          if (cx > branchHorizEnd + 10) return null
          const opStart = 75 + i * 5
          return (
            <circle key={cx} cx={cx} cy={FEAT_Y} r={5}
              fill={colors.bg} stroke={colors.blue} strokeWidth={2}
              opacity={clamp(interpolate(frame, [opStart, opStart + 6], [0, 1]))} />
          )
        })}

        {/* divider line */}
        {divOp > 0 && (
          <line
            x1={LINE_LEFT} y1={DIVIDER_Y}
            x2={LINE_LEFT + divWidth} y2={DIVIDER_Y}
            stroke={colors.border} strokeWidth={1} opacity={divOp}
          />
        )}
      </svg>

      {/* ── Component rows ── */}
      {ROWS.map((row, ri) => {
        const rowTop = ROWS_TOP + ri * (ROW_H + ROW_GAP)
        const rowSp  = spring({ frame: frame - row.start, fps, config: { damping: 16, stiffness: 160 } })
        const rowOp  = interpolate(rowSp, [0, 1], [0, 1])
        const rowX   = interpolate(rowSp, [0, 1], [-40, 0])
        return (
          <div
            key={row.title}
            style={{
              position: "absolute",
              left: LINE_LEFT,
              top: rowTop,
              width: LINE_RIGHT - LINE_LEFT,
              height: ROW_H,
              display: "flex",
              alignItems: "center",
              gap: 18,
              opacity: rowOp,
              transform: `translateX(${rowX}px)`,
              borderBottom: ri < ROWS.length - 1 ? `1px solid ${colors.border}44` : "none",
            }}
          >
            {/* Icon */}
            <span style={{ color: row.color, fontSize: 22, width: 28, textAlign: "center", flexShrink: 0 }}>
              {row.icon}
            </span>
            {/* Title */}
            <span style={{ color: row.color, fontSize: 17, fontWeight: 700, width: 100, flexShrink: 0 }}>
              {row.title}
            </span>
            {/* Dots */}
            <span style={{ color: colors.border, fontSize: 12, letterSpacing: 3, flex: 1 }}>
              {"·".repeat(60)}
            </span>
            {/* Detail */}
            <span style={{ color: colors.muted, fontSize: 13, flexShrink: 0, paddingRight: 8 }}>
              {row.detail}
            </span>
          </div>
        )
      })}

      {/* ── Equation ── */}
      <div
        style={{
          position: "absolute",
          bottom: 38,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: 0.5,
        }}
      >
        {EQ_PARTS.map((part) => {
          const sp  = spring({ frame: frame - part.start, fps, config: { damping: 16, stiffness: 170 } })
          const op  = interpolate(sp, [0, 1], [0, 1])
          const dy  = interpolate(sp, [0, 1], [8, 0])
          const isTask = part.text === "Task"
          const pulse  = isTask && frame > 170
            ? interpolate(((frame - 170) % 60), [0, 30, 60], [0.4, 1, 0.4])
            : 0
          return (
            <span
              key={part.text}
              style={{
                color: part.color,
                opacity: op,
                transform: `translateY(${dy}px)`,
                display: "inline-block",
                ...(isTask && pulse > 0 ? {
                  padding: "3px 16px",
                  background: `${colors.yellow}1A`,
                  border: `1px solid ${colors.yellow}66`,
                  borderRadius: 8,
                  textShadow: `0 0 ${12 + pulse * 18}px ${colors.yellow}`,
                } : {}),
              }}
            >
              {part.text}
            </span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
