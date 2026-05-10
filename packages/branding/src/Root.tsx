import { Composition } from "remotion"
import { BracketChip } from "./BracketChip"
import { GlyphK } from "./GlyphK"
import { PaneGrid } from "./PaneGrid"
import { TaskStreams } from "./TaskStreams"

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="bracket-chip" component={BracketChip} durationInFrames={120} fps={30} width={1200} height={630} />
      <Composition id="pane-grid" component={PaneGrid} durationInFrames={150} fps={30} width={1200} height={800} />
      <Composition id="task-streams" component={TaskStreams} durationInFrames={120} fps={30} width={1200} height={630} />
      <Composition id="glyph-k" component={GlyphK} durationInFrames={150} fps={30} width={800} height={800} />
    </>
  )
}
