/**
 * InputMirror — the floating input row. It's NOT a textarea: it mirrors the
 * engine's native input line (`promptText`) with a blinking caret, and every
 * keystroke drives the hidden real CLI (a click anywhere focuses it). Pasted
 * images echo from the CLI as `[Image #N]` tokens; TokenizedText resolves each
 * to the real cached thumbnail (click to preview).
 */

import { CornerDownLeft } from "lucide-react"
import { TokenizedText } from "./TokenizedText.tsx"

const caret = (
  <span className="inline-block h-[1.05em] w-[2px] animate-pulse bg-primary align-text-bottom" />
)

export function InputMirror({
  promptText,
  sessionId,
}: {
  promptText: string
  sessionId: string | null
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-bg px-4 py-3 shadow-lg shadow-black/25">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
        {promptText ? (
          <>
            <TokenizedText text={promptText} sessionId={sessionId} />
            {caret}
          </>
        ) : (
          <>
            {caret}
            <span className="text-subtle"> Message the agent…</span>
          </>
        )}
      </span>
      <CornerDownLeft
        size={14}
        strokeWidth={2}
        className="shrink-0 text-subtle"
      />
    </div>
  )
}
