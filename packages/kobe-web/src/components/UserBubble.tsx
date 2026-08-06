/**
 * UserBubble — one user message in the /chat transcript (right-aligned chat
 * bubble over the CLI's `> ` echo). Standalone so bubble styling and its
 * copy affordance tune independently of the TTY block renderer.
 */

import { CopyButton } from "./CopyButton.tsx"
import { TokenizedText } from "./TokenizedText.tsx"

export function UserBubble({
  text,
  sessionId,
}: {
  text: string
  sessionId: string | null
}) {
  return (
    <div className="group/user relative my-2 flex justify-end">
      <div className="max-w-[82%] border border-line-active/50 bg-inset px-3.5 py-2 [clip-path:polygon(0_0,calc(100%_-_8px)_0,100%_8px,100%_100%,0_100%)]">
        <span className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
          <TokenizedText text={text} sessionId={sessionId} />
        </span>
      </div>
      {/* Fully below the bubble on hover — same placement as assistant runs. */}
      <CopyButton
        text={text}
        label="Copy message"
        className="absolute right-1 top-full z-10 mt-0.5 bg-menu shadow-md shadow-black/30 opacity-0 focus-visible:opacity-100 group-hover/user:opacity-100"
      />
    </div>
  )
}
