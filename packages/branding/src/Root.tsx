import { Composition } from "remotion"
import { BracketChip } from "./BracketChip"
import { GlyphK } from "./GlyphK"
import { PaneGrid } from "./PaneGrid"
import { QuickLookReplay } from "./quicklook/QuickLookReplay"
import quicklookCapture from "./quicklook/frames.json"
import quicklookSpec from "./quicklook/quicklook.replay.json"
import { replayDurationSeconds } from "./quicklook/replay-spec"
import { TaskStreams } from "./TaskStreams"

export const RemotionRoot: React.FC = () => {
  const quicklookDuration = replayDurationSeconds(quicklookSpec, quicklookCapture)
  const quicklookSpeedCuts = quicklookSpec.delivery?.speedCuts ?? [1, 4]

  return (
    <>
      <Composition id="bracket-chip" component={BracketChip} durationInFrames={120} fps={30} width={1200} height={630} />
      <Composition id="pane-grid" component={PaneGrid} durationInFrames={150} fps={30} width={1200} height={800} />
      <Composition id="task-streams" component={TaskStreams} durationInFrames={120} fps={30} width={1200} height={630} />
      <Composition id="glyph-k" component={GlyphK} durationInFrames={150} fps={30} width={800} height={800} />
      {quicklookSpeedCuts.map((speed) => (
        <Composition
          key={speed}
          id={speed === 1 ? "quicklook-replay" : `quicklook-replay-${speed}x`}
          component={QuickLookReplay}
          defaultProps={speed === 1 ? {} : { speed }}
          durationInFrames={Math.round((quicklookDuration / speed) * 30)}
          fps={30}
          width={quicklookSpec.viewport.width}
          height={quicklookSpec.viewport.height}
        />
      ))}
    </>
  )
}
