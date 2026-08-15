import { AbsoluteFill } from "remotion"
import { InsetFrame, KeyLabel, MONO, T } from "./docs-theme"

// Docs still — the Task unit: worktree + engine session + branch as three
// hairline panels threaded together inside a `task` fieldset, joined by a
// terracotta thread. Rendered to docs/assets/task-model.png (CONCEPTS.md).

const BOX = { x: 130, y: 280, w: 1340, h: 340 }
const PANEL_W = 380
const PANEL_H = 240
const PANEL_Y = 330
const PANEL_XS = [190, 610, 1030]
const MID_Y = BOX.y + BOX.h / 2

type Panel = {
  label: string
  lines: { text: string; color: string; size: number }[]
  dot?: string
}

const PANELS: Panel[] = [
  {
    label: "worktree",
    lines: [
      { text: "~/.rove/worktrees/", color: T.faint, size: 20 },
      { text: "app/fix-auth/", color: T.ink2, size: 25 },
    ],
  },
  {
    label: "engine session",
    lines: [
      { text: "claude", color: T.ink, size: 26 },
      { text: "sid 3f9a…c2 · running", color: T.faint, size: 20 },
    ],
    dot: T.ok,
  },
  {
    label: "branch",
    lines: [
      { text: "rove/fix-auth", color: T.ink2, size: 25 },
      { text: "clean · ahead 2", color: T.faint, size: 20 },
    ],
  },
]

const PanelCard: React.FC<{ panel: Panel; left: number }> = ({ panel, left }) => (
  <div
    style={{
      position: "absolute",
      left,
      top: PANEL_Y,
      width: PANEL_W,
      height: PANEL_H,
      backgroundColor: T.paper2,
      border: `1px solid ${T.rule2}`,
      borderRadius: 13,
      padding: 26,
      display: "flex",
      flexDirection: "column",
    }}
  >
    <div style={{ display: "flex", alignItems: "center" }}>
      <KeyLabel>{panel.label}</KeyLabel>
      {panel.dot ? (
        <div
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            backgroundColor: panel.dot,
            marginLeft: 12,
          }}
        />
      ) : null}
    </div>
    <div style={{ height: 1, backgroundColor: T.rule, margin: "16px 0" }} />
    <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 12 }}>
      {panel.lines.map((line) => (
        <div key={line.text} style={{ fontSize: line.size, color: line.color }}>
          {line.text}
        </div>
      ))}
    </div>
  </div>
)

export const DocsTaskModel: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: T.paper, fontFamily: MONO }}>
      {/* fieldset box */}
      <div
        style={{
          position: "absolute",
          left: BOX.x,
          top: BOX.y,
          width: BOX.w,
          height: BOX.h,
          border: `1px solid ${T.rule2}`,
          borderRadius: 18,
        }}
      />
      {/* legend chip cutting the top border */}
      <div
        style={{
          position: "absolute",
          left: BOX.x + 44,
          top: BOX.y - 20,
          backgroundColor: T.paper,
          padding: "4px 18px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: T.accent, marginRight: 12 }} />
        <div style={{ fontSize: 22, letterSpacing: 2, color: T.muted }}>task</div>
      </div>

      {/* terracotta thread behind the panels */}
      <svg width={1600} height={900} style={{ position: "absolute", inset: 0 }}>
        <line
          x1={PANEL_XS[0]}
          y1={MID_Y}
          x2={PANEL_XS[2] + PANEL_W}
          y2={MID_Y}
          stroke={T.accent}
          strokeWidth={2.5}
        />
      </svg>

      {PANELS.map((panel, i) => (
        <PanelCard key={panel.label} panel={panel} left={PANEL_XS[i]} />
      ))}

      {/* plus signs in the gaps, on the thread */}
      {[0, 1].map((gap) => {
        const cx = (PANEL_XS[gap] + PANEL_W + PANEL_XS[gap + 1]) / 2
        return (
          <div
            key={gap}
            style={{
              position: "absolute",
              left: cx - 22,
              top: MID_Y - 22,
              width: 44,
              height: 44,
              borderRadius: "50%",
              backgroundColor: T.paper,
              border: `1px solid ${T.accent}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              color: T.accent,
            }}
          >
            +
          </div>
        )
      })}

      <InsetFrame />
    </AbsoluteFill>
  )
}
