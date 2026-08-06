/**
 * InputMirror — the floating input row. It's NOT a textarea: it mirrors the
 * engine's native input line (`promptText`) with a blinking caret, and every
 * keystroke drives the hidden real CLI (a click anywhere focuses it). Pasted
 * images echo from the CLI as `[Image #N]` tokens; TokenizedText resolves each
 * to the real cached thumbnail (click to preview).
 */

import { CornerDownLeft, Terminal } from "lucide-react"
import { TokenizedText } from "./TokenizedText.tsx"

const caret = (
  <span className="inline-block h-[1.05em] w-[2px] animate-pulse bg-primary align-text-bottom" />
)

export function InputMirror({
  promptText,
  composing,
  caretOffset,
  sessionId,
}: {
  promptText: string
  /** IME composing string (pinyin buffer) — lives only in the hidden
   *  textarea until committed, so the mirror renders it inline itself. */
  composing?: string | null
  /** Caret CHAR offset within promptText (real terminal cursor); null =
   *  end of line (unknown / cursor elsewhere). */
  caretOffset?: number | null
  sessionId: string | null
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
    <div className="command-dock">
      <div className="command-dock__identity" aria-hidden="true">
        <span className="command-dock__beacon" />
        <Terminal size={13} strokeWidth={1.8} />
        <span>PTY</span>
      </div>
      <div className="command-dock__input">
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
        <span className="command-dock__send" aria-hidden="true">
          <CornerDownLeft size={13} strokeWidth={2} />
        </span>
      </div>
    </div>
  )
}
