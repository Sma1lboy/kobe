import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./theme"
import { SceneShell } from "./ui"

// Branches draw in, merge to trunk, a check pops — then the whole diagram
// scales down into a laptop outline: it all happened on this machine.
export const Scene05Merge: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const draw = interpolate(t, [0.2, 1.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const check = spring({ frame: frame - 1.8 * fps, fps, config: { damping: 12 } })
  // From 3.2s the diagram shrinks into the laptop.
  const shrink = spring({ frame: frame - 3.2 * fps, fps, config: { damping: 18 } })
  const laptopIn = spring({ frame: frame - 3.4 * fps, fps, config: { damping: 16 } })
  const PATH_LEN = 700
  return (
    <SceneShell caption="任务完成，分支合并，worktree 回收；一切都在你自己的机器上。">
      <div
        style={{
          position: "absolute",
          top: 190,
          width: "100%",
          textAlign: "center",
          color: colors.fg,
          fontSize: 62,
          fontWeight: 700,
        }}
      >
        合并，回收，<span style={{ color: colors.blue }}>本地完成</span>
      </div>
      {/* Laptop outline fades in around the shrinking diagram. */}
      <svg
        width="900"
        height="640"
        viewBox="0 0 900 640"
        style={{ position: "absolute", top: 560, left: 90, opacity: laptopIn }}
      >
        <rect x="140" y="20" width="620" height="440" rx="26" fill="none" stroke={colors.fg} strokeWidth="6" />
        <path d="M60 560 L140 460 L760 460 L840 560 Z" fill="none" stroke={colors.fg} strokeWidth="6" />
        <text x="450" y="605" textAnchor="middle" fill={colors.muted} fontFamily={monoStack} fontSize="30">
          your machine · local-first
        </text>
      </svg>
      <div
        style={{
          position: "absolute",
          top: 560,
          left: 140,
          width: 800,
          height: 620,
          transform: `scale(${1 - 0.42 * shrink}) translateY(${shrink * 120}px)`,
          transformOrigin: "50% 40%",
        }}
      >
        <svg width="800" height="620" viewBox="0 0 800 620">
          {/* trunk */}
          <path
            d="M400 40 L400 580"
            stroke={colors.muted}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={PATH_LEN}
            strokeDashoffset={PATH_LEN * (1 - draw)}
          />
          {/* two feature branches merging back */}
          <path
            d="M400 120 C220 160 220 320 400 380"
            stroke={colors.blue}
            strokeWidth="7"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={PATH_LEN}
            strokeDashoffset={PATH_LEN * (1 - draw)}
          />
          <path
            d="M400 180 C580 220 580 360 400 440"
            stroke={colors.cyan}
            strokeWidth="7"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={PATH_LEN}
            strokeDashoffset={PATH_LEN * (1 - draw)}
          />
          <circle cx="400" cy="380" r="13" fill={colors.blue} opacity={draw} />
          <circle cx="400" cy="440" r="13" fill={colors.cyan} opacity={draw} />
          {/* merge check */}
          <g transform={`translate(400 510) scale(${check})`}>
            <circle r="46" fill={colors.green} />
            <path
              d="M-20 2 L-6 16 L24 -16"
              stroke={colors.bg}
              strokeWidth="10"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          top: 470,
          width: "100%",
          textAlign: "center",
          fontFamily: monoStack,
          fontSize: 30,
          color: colors.muted,
          opacity: interpolate(t, [2.0, 2.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          transform: `translateY(${-shrink * 40}px)`,
        }}
      >
        <span style={{ color: colors.green }}>✓ merged</span> · worktree removed
      </div>
    </SceneShell>
  )
}
