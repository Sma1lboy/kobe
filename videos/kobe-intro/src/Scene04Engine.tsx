import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./theme"
import { SceneShell } from "./ui"

// One contract slot, two engines. The workflow ring around the slot never
// moves while the badges swap — that IS the message.
const RING = ["task", "worktree", "branch", "history", "telemetry", "merge"]

const Badge: React.FC<{ label: string; accent: string; p: number; from: "left" | "right" }> = ({
  label,
  accent,
  p,
  from,
}) => (
  <div
    style={{
      position: "absolute",
      inset: 10,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 14,
      backgroundColor: colors.panel,
      border: `3px solid ${accent}`,
      color: accent,
      fontFamily: monoStack,
      fontWeight: 700,
      fontSize: 40,
      opacity: Math.max(0, Math.min(1, p)),
      transform: `translateX(${(1 - p) * (from === "left" ? -420 : 420)}px)`,
    }}
  >
    {label}
  </div>
)

export const Scene04Engine: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const slotIn = spring({ frame, fps, config: { damping: 16 } })
  // Claude docks at 0.8s, leaves at 3.0s; codex docks at 3.4s.
  const claudeIn = spring({ frame: frame - 0.8 * fps, fps, config: { damping: 15 } })
  const claudeOut = spring({ frame: frame - 3.0 * fps, fps, config: { damping: 200 } })
  const codexIn = spring({ frame: frame - 3.4 * fps, fps, config: { damping: 15 } })
  const dashFlow = -t * 60 // constant conveyor motion on the contract ring
  return (
    <SceneShell caption="引擎默认 Claude Code，Codex 走同一套契约；切引擎不换工作流。">
      <div
        style={{
          position: "absolute",
          top: 200,
          width: "100%",
          textAlign: "center",
          color: colors.fg,
          fontSize: 62,
          fontWeight: 700,
          opacity: slotIn,
        }}
      >
        同一套 <span style={{ color: colors.blue }}>engine 契约</span>
      </div>
      {/* Contract ring: fixed nodes, flowing dashes. */}
      <svg
        width="1080"
        height="1080"
        viewBox="0 0 1080 1080"
        style={{ position: "absolute", top: 340, opacity: slotIn }}
      >
        <circle
          cx="540"
          cy="540"
          r="330"
          fill="none"
          stroke={colors.border}
          strokeWidth="3"
          strokeDasharray="14 18"
          strokeDashoffset={dashFlow}
        />
        {RING.map((label, i) => {
          const a = (i / RING.length) * Math.PI * 2 - Math.PI / 2
          const x = 540 + Math.cos(a) * 330
          const y = 540 + Math.sin(a) * 330
          return (
            <g key={label}>
              <circle cx={x} cy={y} r="10" fill={colors.muted} />
              <text
                x={x}
                y={y + (Math.sin(a) > 0.3 ? 46 : -28)}
                textAnchor="middle"
                fill={colors.muted}
                fontFamily={monoStack}
                fontSize="24"
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>
      {/* The slot itself. */}
      <div
        style={{
          position: "absolute",
          top: 340 + 540 - 90,
          left: 540 - 210,
          width: 420,
          height: 180,
          borderRadius: 20,
          border: `3px dashed ${colors.muted}`,
          backgroundColor: colors.bgSoft,
          transform: `scale(${0.8 + 0.2 * slotIn})`,
          opacity: slotIn,
        }}
      >
        <Badge label="Claude Code" accent={colors.blue} p={claudeIn - claudeOut} from="left" />
        <Badge label="Codex" accent={colors.fg} p={codexIn} from="right" />
      </div>
      <div
        style={{
          position: "absolute",
          top: 340 + 540 + 130,
          width: "100%",
          textAlign: "center",
          color: colors.muted,
          fontFamily: monoStack,
          fontSize: 30,
          opacity: interpolate(t, [4.2, 4.8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        切引擎，不换工作流
      </div>
    </SceneShell>
  )
}
