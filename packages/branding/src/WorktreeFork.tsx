import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./colors"

// Worktree Fork — architecture concept
// Timeline:
//  0–28:   main branch draws right, commit dots appear
//  28–45:  fork dot pulses in
//  45–82:  feature branch draws (Bezier curve → horizontal)
//  82–105: feature commits fill in one by one
// 105–145: three chips slide up from below branch, each with a connector
// 145–195: equation assembles token by token
// 195–210: "Task" box pulses with glow

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * Math.min(1, Math.max(0, t))
}

// Layout constants
const MAIN_Y = 185
const BRANCH_Y = 355
const FORK_X = 265
const MAIN_LEFT = 60
const MAIN_RIGHT = 1140
const DIAG_END_X = 410  // where diagonal meets horizontal

// Commit x-positions on each branch
const MAIN_COMMITS = [160, 310, 460]
const FEAT_COMMITS = [530, 680, 820, 960, 1100]

// Chip definitions: each sits below the feature branch, centered on a commit
const CHIPS = [
  {
    label: "⎇  branch",
    detail: "feat/login-fix",
    color: colors.green,
    anchorX: 640,  // where the connector line meets the branch
    start: 105,
  },
  {
    label: "⊞  worktree",
    detail: ".claude/worktrees/…",
    color: colors.magenta,
    anchorX: 820,
    start: 118,
  },
  {
    label: "◉  session",
    detail: "claude-opus-4",
    color: colors.blue,
    anchorX: 1000,
    start: 131,
  },
]

const CHIP_TOP = BRANCH_Y + 55   // top of chip area
const CHIP_H = 62
const CHIP_W = 200

// Equation
const EQ_PARTS = [
  { text: "branch", color: colors.green, start: 145 },
  { text: "  +  ", color: colors.muted, start: 152 },
  { text: "worktree", color: colors.magenta, start: 157 },
  { text: "  +  ", color: colors.muted, start: 164 },
  { text: "session", color: colors.blue, start: 169 },
  { text: "   =   ", color: colors.muted, start: 176 },
  { text: "Task", color: colors.yellow, start: 183 },
]

export const WorktreeFork: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // ── main branch ──────────────────────────────────────────────────
  const mainProgress = interpolate(frame, [0, 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const mainCurrentRight = lerp(MAIN_LEFT, MAIN_RIGHT, mainProgress)

  // ── fork dot ─────────────────────────────────────────────────────
  const forkSp = spring({ frame: frame - 28, fps, config: { damping: 13, stiffness: 220 } })
  const forkR = interpolate(forkSp, [0, 1], [0, 11])
  const forkOpacity = interpolate(forkSp, [0, 1], [0, 1])
  // ripple ring
  const rippleR = interpolate(frame, [28, 52], [0, 28], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })
  const rippleOpacity = interpolate(frame, [28, 52], [0.7, 0], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })

  // ── feature branch path ──────────────────────────────────────────
  // Cubic Bezier: start=(FORK_X, MAIN_Y), control1=(FORK_X, BRANCH_Y-60),
  // control2=(DIAG_END_X-80, BRANCH_Y), end=(DIAG_END_X, BRANCH_Y)
  const branchProgress = interpolate(frame, [45, 82], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  // Two-phase: 0–0.35 = Bezier curve, 0.35–1 = horizontal extension
  const curveP = Math.min(1, branchProgress / 0.35)
  const horizP = Math.max(0, (branchProgress - 0.35) / 0.65)
  const horizCurrentRight = lerp(DIAG_END_X, MAIN_RIGHT, horizP)

  // Approximate the Bezier tip position during curve phase (for path drawing)
  // We'll just draw up to a fraction of the full path using stroke-dashoffset trick via t
  // Since SVG dashoffset trick is cleaner, we define the full path and animate dashoffset
  const CURVE_LEN = 230  // approx length of the Bezier segment
  const HORIZ_LEN = MAIN_RIGHT - DIAG_END_X  // 730
  const totalLen = CURVE_LEN + HORIZ_LEN
  const drawnLen = branchProgress * totalLen
  const dashOffset = totalLen - drawnLen

  // ── feature commits ───────────────────────────────────────────────
  // appear after branch reaches each x
  function featCommitOpacity(cx: number) {
    const branchAtCx = horizP > 0 ? DIAG_END_X + horizP * (MAIN_RIGHT - DIAG_END_X) : DIAG_END_X
    if (cx > branchAtCx + 20) return 0
    const localStart = 82 + ((cx - DIAG_END_X) / (MAIN_RIGHT - DIAG_END_X)) * (105 - 82)
    return interpolate(frame, [localStart, localStart + 8], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })
  }

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, fontFamily: monoStack }}>
      <svg
        width={1200}
        height={630}
        style={{ position: "absolute", inset: 0 }}
        viewBox="0 0 1200 630"
      >
        {/* Subtle horizontal grid lines */}
        {[MAIN_Y, BRANCH_Y].map((y) => (
          <line key={y} x1={40} y1={y} x2={1160} y2={y}
            stroke={colors.border} strokeWidth={1} strokeDasharray="4 8" opacity={0.3} />
        ))}

        {/* ── main branch line ── */}
        <line
          x1={MAIN_LEFT} y1={MAIN_Y} x2={mainCurrentRight} y2={MAIN_Y}
          stroke={colors.muted} strokeWidth={3} strokeLinecap="round"
        />

        {/* main label */}
        <text
          x={MAIN_LEFT} y={MAIN_Y - 20}
          fill={colors.muted} fontSize={14} fontFamily={monoStack} fontWeight={700}
          opacity={interpolate(frame, [2, 12], [0, 1], { extrapolateRight: "clamp" })}
        >
          main
        </text>

        {/* main commit dots */}
        {MAIN_COMMITS.map((cx) => (
          cx < mainCurrentRight - 15 ? (
            <circle key={cx} cx={cx} cy={MAIN_Y} r={6}
              fill={colors.bg} stroke={colors.muted} strokeWidth={2.5}
              opacity={interpolate(frame, [
                (cx / MAIN_RIGHT) * 28,
                (cx / MAIN_RIGHT) * 28 + 6,
              ], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" })} />
          ) : null
        ))}

        {/* ── fork ripple ── */}
        <circle cx={FORK_X} cy={MAIN_Y} r={rippleR}
          fill="none" stroke={colors.blue} strokeWidth={2}
          opacity={rippleOpacity} />

        {/* ── fork dot ── */}
        <circle cx={FORK_X} cy={MAIN_Y} r={forkR}
          fill={colors.blue} opacity={forkOpacity}
          style={{ filter: `drop-shadow(0 0 10px ${colors.blue})` }} />

        {/* ── feature branch (full Bezier + horizontal, animated via dashoffset) ── */}
        {branchProgress > 0 && (
          <path
            d={`M ${FORK_X} ${MAIN_Y}
                C ${FORK_X} ${BRANCH_Y - 55}, ${DIAG_END_X - 70} ${BRANCH_Y}, ${DIAG_END_X} ${BRANCH_Y}
                L ${MAIN_RIGHT} ${BRANCH_Y}`}
            stroke={colors.blue}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${totalLen} ${totalLen}`}
            strokeDashoffset={dashOffset}
            style={{ filter: `drop-shadow(0 0 5px ${colors.blue}66)` }}
          />
        )}

        {/* feat label */}
        {branchProgress > 0.38 && (
          <text
            x={DIAG_END_X + 12} y={BRANCH_Y - 18}
            fill={colors.blue} fontSize={13} fontFamily={monoStack}
            opacity={interpolate(frame, [66, 76], [0, 1], { extrapolateRight: "clamp" })}
          >
            feat/login-fix
          </text>
        )}

        {/* feature commit dots */}
        {FEAT_COMMITS.map((cx) => {
          const op = featCommitOpacity(cx)
          return op > 0 ? (
            <circle key={cx} cx={cx} cy={BRANCH_Y} r={6}
              fill={colors.bg} stroke={colors.blue} strokeWidth={2.5} opacity={op} />
          ) : null
        })}

        {/* ── chip connector lines ── */}
        {CHIPS.map((chip) => {
          const connSp = spring({ frame: frame - chip.start, fps, config: { damping: 16, stiffness: 150 } })
          const connOpacity = interpolate(connSp, [0, 1], [0, 0.45])
          const connLen = interpolate(connSp, [0, 1], [0, CHIP_TOP - BRANCH_Y])
          return (
            <line key={chip.label}
              x1={chip.anchorX} y1={BRANCH_Y}
              x2={chip.anchorX} y2={BRANCH_Y + connLen}
              stroke={chip.color} strokeWidth={1.5} strokeDasharray="4 4"
              opacity={connOpacity} />
          )
        })}
      </svg>

      {/* ── Chip cards (HTML overlay for border-radius + text) ── */}
      {CHIPS.map((chip) => {
        const chipSp = spring({ frame: frame - chip.start, fps, config: { damping: 15, stiffness: 160 } })
        const chipOpacity = interpolate(chipSp, [0, 1], [0, 1])
        const chipY = interpolate(chipSp, [0, 1], [16, 0])
        return (
          <div
            key={chip.label}
            style={{
              position: "absolute",
              left: chip.anchorX - CHIP_W / 2,
              top: CHIP_TOP,
              width: CHIP_W,
              height: CHIP_H,
              opacity: chipOpacity,
              transform: `translateY(${chipY}px)`,
              background: `${chip.color}14`,
              border: `1px solid ${chip.color}55`,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            <span style={{ color: chip.color, fontSize: 15, fontWeight: 700 }}>{chip.label}</span>
            <span style={{ color: colors.muted, fontSize: 11 }}>{chip.detail}</span>
          </div>
        )
      })}

      {/* ── Equation ── */}
      <div
        style={{
          position: "absolute",
          bottom: 46,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontSize: 26,
          fontWeight: 700,
        }}
      >
        {EQ_PARTS.map((part) => {
          const sp = spring({ frame: frame - part.start, fps, config: { damping: 16, stiffness: 170 } })
          const opacity = interpolate(sp, [0, 1], [0, 1])
          const y = interpolate(sp, [0, 1], [10, 0])
          const isTask = part.text === "Task"
          const glowPulse = isTask && frame > 195
            ? interpolate(((frame - 195) % 60), [0, 30, 60], [0.5, 1, 0.5])
            : 0
          return (
            <span
              key={part.text}
              style={{
                color: part.color,
                opacity,
                transform: `translateY(${y}px)`,
                display: "inline-block",
                ...(isTask && glowPulse > 0 ? {
                  textShadow: `0 0 ${16 + glowPulse * 20}px ${colors.yellow}`,
                  padding: "2px 14px",
                  background: `${colors.yellow}18`,
                  border: `1px solid ${colors.yellow}55`,
                  borderRadius: 8,
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
