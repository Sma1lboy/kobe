import { spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./theme"
import { SceneShell, Wordmark } from "./ui"

// The mess resolves: wordmark lights up, then three task cards settle into a
// column, each carrying the task unit triple — worktree path + branch + agent.
const TASKS = [
  { name: "fix-auth", branch: "kobe/fix-auth", path: "~/.claude/worktrees/fix-auth" },
  { name: "new-api", branch: "kobe/new-api", path: "~/.claude/worktrees/new-api" },
  { name: "refactor", branch: "kobe/refactor", path: "~/.claude/worktrees/refactor" },
]

const BranchGlyph: React.FC<{ drawn: number }> = ({ drawn }) => (
  <svg width="46" height="34" viewBox="0 0 46 34" style={{ flexShrink: 0 }}>
    <path
      d="M6 30 L6 12 M6 12 C6 4 14 4 20 4 L40 4"
      stroke={colors.blue}
      strokeWidth="3.5"
      fill="none"
      strokeLinecap="round"
      strokeDasharray={70}
      strokeDashoffset={70 * (1 - drawn)}
    />
    <circle cx="6" cy="30" r="4.5" fill={colors.muted} />
    <circle cx="40" cy="4" r="4.5" fill={colors.blue} opacity={drawn} />
  </svg>
)

export const Scene02Kobe: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const markIn = spring({ frame, fps, config: { damping: 16 } })
  return (
    <SceneShell caption="kobe，一个本地优先的终端 UI，把每个任务变成独立的 git worktree、独立分支、独立 agent 会话。">
      <div style={{ position: "absolute", top: 210, width: "100%", textAlign: "center" }}>
        <div style={{ transform: `scale(${0.6 + 0.4 * markIn})`, opacity: markIn }}>
          <Wordmark size={170} />
        </div>
        <div
          style={{
            marginTop: 18,
            color: colors.muted,
            fontFamily: monoStack,
            fontSize: 34,
            opacity: markIn,
          }}
        >
          local-first · terminal-native
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 620,
          left: 120,
          right: 120,
          display: "flex",
          flexDirection: "column",
          gap: 44,
        }}
      >
        {TASKS.map((t, i) => {
          const inAt = (0.9 + i * 0.35) * fps
          const p = spring({ frame: frame - inAt, fps, config: { damping: 15 } })
          return (
            <div
              key={t.name}
              style={{
                borderRadius: 16,
                border: `2px solid ${colors.border}`,
                backgroundColor: colors.bgSoft,
                padding: "26px 34px",
                opacity: p,
                transform: `translateX(${(1 - p) * (i % 2 === 0 ? -140 : 140)}px)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <span style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: colors.green }} />
                <span style={{ color: colors.fg, fontFamily: monoStack, fontWeight: 700, fontSize: 38 }}>
                  {t.name}
                </span>
                <span style={{ marginLeft: "auto", color: colors.muted, fontSize: 26 }}>agent 会话</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 20 }}>
                <BranchGlyph drawn={p} />
                <span style={{ color: colors.cyan, fontFamily: monoStack, fontSize: 27 }}>{t.branch}</span>
              </div>
              <div style={{ color: colors.muted, fontFamily: monoStack, fontSize: 25, marginTop: 10 }}>{t.path}</div>
            </div>
          )
        })}
      </div>
    </SceneShell>
  )
}
