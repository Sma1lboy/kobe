import { Series, useVideoConfig } from "remotion"
import { Scene01Chaos } from "./Scene01Chaos"
import { Scene02Kobe } from "./Scene02Kobe"
import { Scene03Cockpit } from "./Scene03Cockpit"
import { Scene04Engine } from "./Scene04Engine"
import { Scene05Merge } from "./Scene05Merge"
import { Scene06Install } from "./Scene06Install"

// Cumulative SRT boundaries (seconds). Frame starts are rounded from these —
// never round per-scene durations and sum them, that drifts (storyboard.md).
export const SRT_BOUNDS = [0, 4.5, 10, 16, 22, 28, 34] as const

const SCENES = [Scene01Chaos, Scene02Kobe, Scene03Cockpit, Scene04Engine, Scene05Merge, Scene06Install]

export const totalFrames = (fps: number) => Math.round(SRT_BOUNDS[SRT_BOUNDS.length - 1] * fps)

export const KobeIntro: React.FC = () => {
  const { fps } = useVideoConfig()
  const starts = SRT_BOUNDS.map((s) => Math.round(s * fps))
  return (
    <Series>
      {SCENES.map((Scene, i) => (
        <Series.Sequence key={i} durationInFrames={starts[i + 1] - starts[i]}>
          <Scene />
        </Series.Sequence>
      ))}
    </Series>
  )
}
