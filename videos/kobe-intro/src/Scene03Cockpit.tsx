import { spring, useCurrentFrame, useVideoConfig } from "remotion"
import { colors, monoStack } from "./theme"
import { QuickLookReplay } from "./replay/QuickLookReplay"
import { SceneShell } from "./ui"

// The real product, not a mockup: a slice of the quicklook capture (prompt
// typed -> agent streaming) replayed at 4x inside a framed card. Re-run the
// capture script after UI changes and this scene follows automatically.
const CARD_W = 940
const SCALE = CARD_W / 1280

export const Scene03Cockpit: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const cardIn = spring({ frame, fps, config: { damping: 17 } })
  const labels = ["任务列表", "对话 / 文件 / 终端"]
  return (
    <SceneShell caption="左边是任务列表，右边是对话、文件和终端；像指挥台一样，同时推进多条开发线。">
      <div
        style={{
          position: "absolute",
          top: 170,
          width: "100%",
          textAlign: "center",
          color: colors.fg,
          fontSize: 64,
          fontWeight: 700,
          opacity: cardIn,
        }}
      >
        你的<span style={{ color: colors.blue }}>指挥台</span>
      </div>
      <div
        style={{
          position: "absolute",
          top: 360,
          left: (1080 - CARD_W) / 2,
          width: CARD_W,
          height: 720 * SCALE,
          borderRadius: 18,
          border: `2px solid ${colors.border}`,
          overflow: "hidden",
          transform: `scale(${0.92 + 0.08 * cardIn})`,
          opacity: cardIn,
          boxShadow: `0 30px 80px ${colors.bg}`,
        }}
      >
        <div style={{ width: 1280, height: 720, transform: `scale(${SCALE})`, transformOrigin: "0 0" }}>
          {/* engine-boot wide -> type-prompt zoom slice of the capture, 4x. */}
          <QuickLookReplay speed={4} startAt={15} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 360 + 720 * SCALE + 60,
          width: "100%",
          display: "flex",
          justifyContent: "center",
          gap: 28,
        }}
      >
        {labels.map((l, i) => {
          const p = spring({ frame: frame - (0.8 + i * 0.3) * fps, fps, config: { damping: 15 } })
          return (
            <span
              key={l}
              style={{
                padding: "14px 30px",
                borderRadius: 999,
                border: `2px solid ${colors.border}`,
                backgroundColor: colors.bgSoft,
                color: i === 0 ? colors.blue : colors.fg,
                fontFamily: monoStack,
                fontSize: 30,
                opacity: p,
                transform: `translateY(${(1 - p) * 30}px)`,
              }}
            >
              {l}
            </span>
          )
        })}
      </div>
    </SceneShell>
  )
}
