import { AbsoluteFill } from "remotion"
import { InsetFrame, KeyLabel, MONO, T } from "./docs-theme"

// Docs still — fan-out: one prompt box fans out to three task cards.
// Each card carries the Task triple as tiny mono rows: worktree, engine,
// branch. Rendered to docs/assets/fan-out.png (QUICKSTART.md).

type TaskCard = {
  name: string
  engine: string
  status: "running" | "queued"
}

const CARDS: TaskCard[] = [
  { name: "task-a", engine: "claude", status: "running" },
  { name: "task-b", engine: "codex", status: "running" },
  { name: "task-c", engine: "claude", status: "queued" },
]

const CARD_W = 830
const CARD_H = 196
const CARD_X = 640
const CARD_TOPS = [96, 352, 608]
const PROMPT = { x: 100, y: 345, w: 380, h: 210 }
const PROMPT_MID_Y = PROMPT.y + PROMPT.h / 2
const PROMPT_RIGHT = PROMPT.x + PROMPT.w

const Card: React.FC<{ card: TaskCard; top: number }> = ({ card, top }) => (
  <div
    style={{
      position: "absolute",
      left: CARD_X,
      top,
      width: CARD_W,
      height: CARD_H,
      backgroundColor: T.paper2,
      border: `1px solid ${T.rule2}`,
      borderRadius: 13,
      padding: "22px 28px",
      display: "flex",
      flexDirection: "column",
    }}
  >
    <div style={{ display: "flex", alignItems: "center" }}>
      <div style={{ width: 11, height: 11, borderRadius: "50%", backgroundColor: T.accent }} />
      <div style={{ marginLeft: 14, fontSize: 27, fontWeight: 500, color: T.ink }}>{card.name}</div>
      <div style={{ flexGrow: 1 }} />
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          backgroundColor: card.status === "running" ? T.ok : T.dim,
        }}
      />
      <div
        style={{
          marginLeft: 10,
          fontSize: 20,
          color: card.status === "running" ? T.ok : T.muted,
        }}
      >
        {card.status}
      </div>
    </div>
    <div style={{ height: 1, backgroundColor: T.rule, margin: "15px 0" }} />
    {[
      ["wt", `~/.rove/worktrees/app/${card.name}`],
      ["engine", card.engine],
      ["branch", `rove/${card.name}`],
    ].map(([key, value]) => (
      <div key={key} style={{ display: "flex", alignItems: "baseline", height: 30 }}>
        <div style={{ width: 92, fontSize: 20, color: T.dim }}>{key}</div>
        <div style={{ fontSize: 22, color: T.ink2 }}>{value}</div>
      </div>
    ))}
  </div>
)

export const DocsFanOut: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: T.paper, fontFamily: MONO }}>
      {/* Terracotta fan-out curves, under the cards */}
      <svg width={1600} height={900} style={{ position: "absolute", inset: 0 }}>
        {CARD_TOPS.map((top) => {
          const y = top + CARD_H / 2
          return (
            <g key={top}>
              <path
                d={`M ${PROMPT_RIGHT} ${PROMPT_MID_Y} C ${PROMPT_RIGHT + 80} ${PROMPT_MID_Y}, ${CARD_X - 80} ${y}, ${CARD_X} ${y}`}
                fill="none"
                stroke={T.accent}
                strokeWidth={2.5}
              />
              <circle cx={CARD_X} cy={y} r={5} fill={T.accent} />
            </g>
          )
        })}
        <circle cx={PROMPT_RIGHT} cy={PROMPT_MID_Y} r={6} fill={T.accent} />
      </svg>

      {/* Prompt box */}
      <div
        style={{
          position: "absolute",
          left: PROMPT.x,
          top: PROMPT.y,
          width: PROMPT.w,
          height: PROMPT.h,
          backgroundColor: T.well,
          border: `1px solid ${T.rule2}`,
          borderRadius: 13,
          padding: 26,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <KeyLabel>prompt</KeyLabel>
        <div
          style={{
            marginTop: 24,
            fontSize: 25,
            color: T.ink,
            display: "flex",
            alignItems: "center",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: T.accent, marginRight: 14 }}>&gt;</span>
          <span>fix the auth flow</span>
          <span
            style={{
              display: "inline-block",
              width: 13,
              height: 28,
              backgroundColor: T.accent,
              marginLeft: 10,
            }}
          />
        </div>
        <div style={{ marginTop: 18, fontSize: 20, color: T.dim }}>--agents claude:2,codex:1</div>
      </div>

      {CARDS.map((card, i) => (
        <Card key={card.name} card={card} top={CARD_TOPS[i]} />
      ))}

      <InsetFrame />
    </AbsoluteFill>
  )
}
