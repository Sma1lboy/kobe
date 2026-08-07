import { GitBranch, X } from "lucide-react"
import { useEffect, useState } from "react"
import {
  durationMs,
  type TimelineModel,
  type TimelineStatus,
} from "../lib/timeline.ts"
import type { PendingTraceQuote } from "../lib/trace-content.ts"
import { ExecutionGrid, formatExecutionDuration } from "./ExecutionGrid.tsx"

function statusClass(status: TimelineStatus): string {
  if (status === "running") return "border-kobe-blue text-kobe-blue"
  if (status === "error") return "border-kobe-red text-kobe-red"
  if (status === "blocked") return "border-kobe-yellow text-kobe-yellow"
  return "border-kobe-green/50 text-muted"
}

export function TimelineSwimlane({
  model,
  engineLabel,
  runId,
  onQuote,
  onClose,
}: {
  model: TimelineModel
  engineLabel: string
  runId?: string
  onQuote?: (quote: PendingTraceQuote) => Promise<void>
  onClose: () => void
}) {
  const running = model.turns.some((turn) => turn.status === "running")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-bg"
      role="dialog"
      aria-modal="true"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <div className="grid size-8 place-items-center border border-primary/50 text-primary">
          <GitBranch size={15} strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-fg">Agent trace</h2>
          <div className="font-mono text-[10px] text-subtle">
            {engineLabel} · {model.turns.length}{" "}
            {model.turns.length === 1 ? "turn" : "turns"}
            {runId ? ` · run ${runId.slice(0, 8)}` : ""}
            {model.sessionId ? ` · ${model.sessionId.slice(0, 8)}` : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 font-mono text-[10px] text-subtle">
          <span className="size-1.5 rounded-full bg-kobe-blue" />
          Visible commentary · causal provenance · tool branches
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-3 grid size-8 place-items-center border border-line text-subtle hover:border-line-active hover:text-fg"
          aria-label="Close agent trace"
          title="Close"
        >
          <X size={14} />
        </button>
      </header>

      <div className="execution-grid min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
          {model.turns.length === 0 ? (
            <div className="grid min-h-96 place-items-center font-mono text-[11px] text-subtle">
              No execution events yet.
            </div>
          ) : (
            model.turns.map((turn, turnIndex) => (
              <section
                key={turn.id}
                className="grid grid-cols-[156px_minmax(0,1fr)] border border-line bg-bg/90"
              >
                <div className="flex flex-col border-r border-line bg-surface p-4">
                  <span className="font-mono text-[9px] font-bold tracking-[0.14em] text-primary">
                    TURN {String(turnIndex + 1).padStart(2, "0")}
                  </span>
                  <span className="mt-3 text-[12px] font-medium leading-relaxed text-fg">
                    {turn.title}
                  </span>
                  <span
                    className={`mt-auto pt-5 font-mono text-[9px] uppercase ${statusClass(turn.status).split(" ")[1]}`}
                  >
                    {turn.status}
                  </span>
                  <span className="mt-1 font-mono text-[9px] text-subtle">
                    {formatExecutionDuration(
                      durationMs(turn.startedAt, turn.endedAt, now),
                    )}
                  </span>
                </div>
                <div className="min-w-0 p-4">
                  <ExecutionGrid
                    items={turn.nodes}
                    status={turn.status}
                    now={now}
                    onQuote={onQuote}
                    className="execution-node-grid--wide"
                  />
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
