import { Composition } from "remotion"
import { BracketChip } from "./BracketChip"
import { GlyphK } from "./GlyphK"
import { PaneGrid } from "./PaneGrid"
import { SessionGrid } from "./SessionGrid"
import { TaskStreams } from "./TaskStreams"
import { TuiBoot } from "./TuiBoot"
import { WorktreeFork } from "./WorktreeFork"

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ── Original brand set ── */}
      <Composition id="bracket-chip" component={BracketChip} durationInFrames={120} fps={30} width={1200} height={630} />
      <Composition id="pane-grid" component={PaneGrid} durationInFrames={150} fps={30} width={1200} height={800} />
      <Composition id="task-streams" component={TaskStreams} durationInFrames={120} fps={30} width={1200} height={630} />
      <Composition id="glyph-k" component={GlyphK} durationInFrames={150} fps={30} width={800} height={800} />

      {/* ── Product story set ── */}
      <Composition id="tui-boot" component={TuiBoot} durationInFrames={210} fps={30} width={1200} height={750} />
      <Composition id="worktree-fork" component={WorktreeFork} durationInFrames={210} fps={30} width={1200} height={630} />
      <Composition id="session-grid" component={SessionGrid} durationInFrames={270} fps={30} width={1200} height={700} />
    </>
  )
}
