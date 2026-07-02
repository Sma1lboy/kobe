import { Composition } from "remotion"
import { KobeIntro, totalFrames } from "./KobeIntro"

// 34s vertical promo from the kobe-intro voiceover script (storyboard.md).
export const RemotionRoot: React.FC = () => (
  <Composition id="kobe-intro" component={KobeIntro} durationInFrames={totalFrames(30)} fps={30} width={1080} height={1920} />
)
