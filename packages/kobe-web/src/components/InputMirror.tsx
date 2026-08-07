/**
 * InputMirror — the floating input row. It's NOT a textarea: it mirrors the
 * engine's native input line (`promptText`) with a blinking caret, and every
 * keystroke drives the hidden real CLI (a click anywhere focuses it). Pasted
 * images echo from the CLI as `[Image #N]` tokens; TokenizedText resolves each
 * to the real cached thumbnail (click to preview).
 */

import { CornerDownLeft } from "lucide-react"
import type { PendingTraceQuote } from "../lib/trace-content.ts"
import { TokenizedText } from "./TokenizedText.tsx"
import { TraceQuoteBuffer } from "./TraceQuoteBuffer.tsx"

const caret = (
  <span className="inline-block h-[1.05em] w-[2px] animate-pulse bg-primary align-text-bottom" />
)

export function InputMirror({
  promptText,
  composing,
  caretOffset,
  sessionId,
  pendingQuotes = [],
  onRemovePendingQuote,
  submittingQuotes = false,
}: {
  promptText: string
  /** IME composing string (pinyin buffer) — lives only in the hidden
   *  textarea until committed, so the mirror renders it inline itself. */
  composing?: string | null
  /** Caret CHAR offset within promptText (real terminal cursor); null =
   *  end of line (unknown / cursor elsewhere). */
  caretOffset?: number | null
  sessionId: string | null
  pendingQuotes?: readonly PendingTraceQuote[]
  onRemovePendingQuote?: (sourceId: string) => void
  submittingQuotes?: boolean
}) {
  const composingSeg = composing ? (
    <span className="text-primary underline decoration-dotted underline-offset-2">
      {composing}
    </span>
  ) : null
  // Split at the real cursor when it's mid-line; caret trails the text (and
  // the composing run — IME inserts at the cursor) otherwise.
  const splitAt =
    caretOffset != null && caretOffset < promptText.length ? caretOffset : null
  return (
    <div className="space-y-1.5">
      <TraceQuoteBuffer
        quotes={pendingQuotes}
        onRemove={onRemovePendingQuote}
        submitting={submittingQuotes}
      />
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-bg px-4 py-3 shadow-lg shadow-black/25">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
          {promptText || composingSeg ? (
            splitAt !== null ? (
              <>
                <TokenizedText
                  text={promptText.slice(0, splitAt)}
                  sessionId={sessionId}
                />
                {composingSeg}
                {caret}
                <TokenizedText
                  text={promptText.slice(splitAt)}
                  sessionId={sessionId}
                />
              </>
            ) : (
              <>
                {promptText && (
                  <TokenizedText text={promptText} sessionId={sessionId} />
                )}
                {composingSeg}
                {caret}
              </>
            )
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
    </div>
  )
}
