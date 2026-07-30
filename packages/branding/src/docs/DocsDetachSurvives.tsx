import { AbsoluteFill } from "remotion"
import { InsetFrame, KeyLabel, MONO, T } from "./docs-theme"

// Docs still — detach survives: a dashed (detached) TUI window floats away
// while the daemon / PTY-host row below stays lit: engine process, scrollback
// ring, task list. Rendered to docs/assets/detach-survives.png (SESSIONS.md).

const WIN = { x: 400, y: 130, w: 800, h: 270 }
const PANEL = { x: 220, y: 550, w: 1160, h: 250 }
const CENTER_X = 800

const CELLS: { key: string; value: string; dot?: string }[] = [
  { key: "engine", value: "running", dot: T.ok },
  { key: "scrollback", value: "512 KiB ring" },
  { key: "tasks", value: "on disk" },
]

const dashed = `2px dashed ${T.dim}`

export const DocsDetachSurvives: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: T.paper, fontFamily: MONO }}>
      {/* detach trajectory + drop connector */}
      <svg width={1600} height={900} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <marker id="detach-arrow" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={T.dim} />
          </marker>
        </defs>
        <path
          d={`M ${WIN.x + WIN.w - 80} ${WIN.y} C ${WIN.x + WIN.w + 40} ${WIN.y - 60}, ${WIN.x + WIN.w + 110} ${WIN.y - 85}, ${WIN.x + WIN.w + 180} ${WIN.y - 90}`}
          fill="none"
          stroke={T.dim}
          strokeWidth={2}
          strokeDasharray="8 8"
          markerEnd="url(#detach-arrow)"
        />
        <line
          x1={CENTER_X}
          y1={WIN.y + WIN.h}
          x2={CENTER_X}
          y2={PANEL.y - 26}
          stroke={T.dim}
          strokeWidth={2}
          strokeDasharray="8 8"
        />
      </svg>

      {/* detached TUI window */}
      <div
        style={{
          position: "absolute",
          left: WIN.x,
          top: WIN.y,
          width: WIN.w,
          height: WIN.h,
          border: dashed,
          borderRadius: 13,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            height: 46,
            borderBottom: dashed,
            display: "flex",
            alignItems: "center",
            padding: "0 20px",
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: 11,
                height: 11,
                borderRadius: "50%",
                border: `2px dashed ${T.dim}`,
                marginRight: 10,
              }}
            />
          ))}
          <div style={{ flexGrow: 1 }} />
          <div style={{ fontSize: 20, color: T.dim }}>tui</div>
          <div style={{ flexGrow: 1 }} />
          <div style={{ width: 63 }} />
        </div>
        <div
          style={{
            flexGrow: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 26, color: T.faint }}>detached</div>
          <div style={{ fontSize: 20, color: T.dim }}>ctrl+q</div>
        </div>
      </div>

      {/* survivor panel, stays lit */}
      <div
        style={{
          position: "absolute",
          left: PANEL.x,
          top: PANEL.y,
          width: PANEL.w,
          height: PANEL.h,
          backgroundColor: T.paper2,
          border: `1px solid ${T.rule2}`,
          borderRadius: 13,
          padding: "24px 28px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ position: "absolute", left: 0, top: 24, bottom: 24, width: 4, backgroundColor: T.accent, borderRadius: 2 }} />
        <KeyLabel>pty host · daemon</KeyLabel>
        <div style={{ height: 1, backgroundColor: T.rule, margin: "16px 0" }} />
        <div style={{ flexGrow: 1, display: "flex" }}>
          {CELLS.map((cell, i) => (
            <div
              key={cell.key}
              style={{
                flexGrow: 1,
                flexBasis: 0,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 14,
                paddingLeft: i === 0 ? 0 : 28,
                borderLeft: i === 0 ? "none" : `1px solid ${T.rule}`,
              }}
            >
              <KeyLabel>{cell.key}</KeyLabel>
              <div style={{ display: "flex", alignItems: "center" }}>
                {cell.dot ? (
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      backgroundColor: cell.dot,
                      marginRight: 12,
                    }}
                  />
                ) : null}
                <div style={{ fontSize: 24, color: T.ink }}>{cell.value}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <InsetFrame />
    </AbsoluteFill>
  )
}
