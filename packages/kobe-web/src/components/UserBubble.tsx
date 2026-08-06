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
    <div className="group/user relative my-3 flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-inset px-3.5 py-2">
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
