import { Quote, X } from "lucide-react"
import type { PendingTraceQuote } from "../lib/trace-content.ts"

export function TraceQuoteBuffer({
  quotes,
  onRemove,
  submitting = false,
}: {
  quotes: readonly PendingTraceQuote[]
  onRemove?: (sourceId: string) => void
  submitting?: boolean
}) {
  if (quotes.length === 0) return null
  return (
    <div
      data-testid="trace-quote-buffer"
      className="flex flex-wrap gap-1.5 border-l-2 border-primary/70 pl-2"
    >
      {quotes.map((quote) => (
        <div
          key={quote.sourceId}
          className="group flex min-w-0 max-w-full items-center gap-1.5 border border-line bg-surface px-2 py-1 text-[10px] text-muted"
        >
          <Quote
            size={10}
            strokeWidth={1.8}
            className="shrink-0 text-primary"
          />
          <span className="truncate font-mono">{quote.label}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(quote.sourceId)}
              disabled={submitting}
              className="grid size-4 shrink-0 place-items-center text-subtle transition-colors hover:text-kobe-red focus-visible:text-kobe-red focus-visible:outline-none disabled:opacity-40"
              aria-label={`Remove quoted block: ${quote.label}`}
              title="Remove quoted block"
            >
              <X size={10} strokeWidth={2} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
