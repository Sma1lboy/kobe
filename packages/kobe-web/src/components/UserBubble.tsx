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
    // Mirror of CopyableRegion's reserved action row, right-aligned: same
    // bare button and hover behavior as assistant runs, no overlay card.
    <div className="group/user my-2 flex flex-col items-end">
      <div className="max-w-[82%] rounded-2xl rounded-br-md border border-line-active/50 bg-inset px-3.5 py-2">
        <span className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
          <TokenizedText text={text} sessionId={sessionId} />
        </span>
      </div>
      <div className="flex h-5 items-center">
        <CopyButton
          text={text}
          label="Copy message"
          className="opacity-0 focus-visible:opacity-100 group-hover/user:opacity-100"
        />
      </div>
    </div>
  )
}
