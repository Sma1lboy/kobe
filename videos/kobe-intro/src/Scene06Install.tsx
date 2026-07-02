import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./theme"
import { SceneShell, WindowCard, Wordmark } from "./ui"

const CMD = "npm install -g @sma1lboy/kobe"
const AGENTS = [colors.blue, colors.green, colors.yellow, colors.magenta, colors.cyan]

// Typewriter install command, wordmark lockup, parallel agent dots, slogan.
export const Scene06Install: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  // Type over 0.3s..2.1s, deterministic per-frame character count.
  const typed = Math.floor(
    interpolate(t, [0.3, 2.1], [0, CMD.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  )
  const cursorOn = Math.floor(t * 2.5) % 2 === 0
  const done = spring({ frame: frame - 2.5 * fps, fps, config: { damping: 15 } })
  const markIn = spring({ frame: frame - 3.0 * fps, fps, config: { damping: 14 } })
  const sloganIn = spring({ frame: frame - 4.0 * fps, fps, config: { damping: 200 } })
  return (
    <SceneShell caption="npm install -g @sma1lboy/kobe。让 agent 并行，让你专注。">
      <div style={{ position: "absolute", top: 300, left: 90 }}>
        <WindowCard width={900} height={230} title="terminal">
          <div style={{ fontFamily: monoStack, fontSize: 31, color: colors.fg, padding: 10 }}>
            <span style={{ color: colors.green }}>$ </span>
            {CMD.slice(0, typed)}
            <span style={{ opacity: cursorOn ? 1 : 0, color: colors.blue }}>▊</span>
            <div style={{ marginTop: 22, color: colors.muted, opacity: done }}>
              added 1 package — <span style={{ color: colors.green }}>ready</span>
            </div>
          </div>
        </WindowCard>
      </div>
      <div style={{ position: "absolute", top: 720, width: "100%", textAlign: "center" }}>
        <div style={{ transform: `scale(${0.7 + 0.3 * markIn})`, opacity: markIn }}>
          <Wordmark size={200} />
        </div>
      </div>
      {/* Parallel agent streams flowing past the wordmark. */}
      <svg width="1080" height="260" viewBox="0 0 1080 260" style={{ position: "absolute", top: 1000, opacity: markIn }}>
        {AGENTS.map((c, i) => {
          const y = 30 + i * 50
          const x = ((t * (160 + i * 34) + i * 210) % 1300) - 110
          return (
            <g key={c}>
              <line x1="0" y1={y} x2="1080" y2={y} stroke={colors.border} strokeWidth="2" />
              <circle cx={x} cy={y} r="9" fill={c} />
              <circle cx={x - 26} cy={y} r="5" fill={c} opacity="0.5" />
              <circle cx={x - 46} cy={y} r="3" fill={c} opacity="0.25" />
            </g>
          )
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          top: 1330,
          width: "100%",
          textAlign: "center",
          color: colors.fg,
          fontSize: 66,
          fontWeight: 700,
          opacity: sloganIn,
          transform: `translateY(${(1 - sloganIn) * 30}px)`,
        }}
      >
        让 agent 并行，<span style={{ color: colors.blue }}>让你专注</span>。
      </div>
    </SceneShell>
  )
}
