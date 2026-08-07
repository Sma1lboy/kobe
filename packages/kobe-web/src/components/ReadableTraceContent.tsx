import { readableTraceContent } from "../lib/trace-content.ts"
import { CopyButton } from "./CopyButton.tsx"

export function ReadableTraceContent({
  label,
  text,
}: {
  label: string
  text: string
}) {
  const fields = readableTraceContent(label, text)
  const compact = fields.filter((field) => field.tone === "value")
  const bodies = fields.filter((field) => field.tone !== "value")
  return (
    <section className="rounded border border-line bg-surface">
      <header className="flex h-9 items-center gap-2 border-b border-line px-3">
        <span className="text-[11px] text-muted">{label}</span>
        <CopyButton
          text={text}
          label={`Copy ${label.toLowerCase()}`}
          className="ml-auto"
        />
      </header>
      <div className="flex max-h-[48vh] flex-col gap-3 overflow-auto p-3">
        {compact.length > 0 && (
          <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-b border-line-subtle pb-3 text-[10px]">
            {compact.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-subtle">{field.label}</dt>
                <dd className="min-w-0 break-words font-mono text-muted">
                  {field.text}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {bodies.map((field) => (
          <div key={field.label}>
            {fields.length > 1 && (
              <div className="mb-1.5 text-[9px] uppercase tracking-[0.12em] text-subtle">
                {field.label}
              </div>
            )}
            <div
              className={`whitespace-pre-wrap break-words text-[11px] leading-relaxed text-fg ${field.tone === "code" ? "font-mono" : ""}`}
            >
              {field.text}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
