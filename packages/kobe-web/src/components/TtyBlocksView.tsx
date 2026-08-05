/**
 * TtyBlocksView — render the TTY-translated blocks (lib/claude-tty.ts) as
 * styled HTML. Recognized shapes get light restyling (boxes → cards, user
 * echo → chip, ⏺ prose → dot rows, tool heads → mono rows with attached ⎿
 * results); everything else passes through verbatim in mono. The content is
 * ALWAYS the real terminal's — we restyle, we never reimplement a widget.
 */

import { useEffect, useMemo, useRef } from "react"
import { parseTtyBlocks, type TtyBlock } from "../lib/claude-tty.ts"

/** Strip the box-drawing frame from one line of a ╭─╮ box. */
function stripBoxFrame(line: string): string {
  return line
    .replace(/^\s*[╭╰]─*[╮╯]?\s*$/, "")
    .replace(/^\s*│\s?/, "")
    .replace(/\s?│\s*$/, "")
    .trimEnd()
}

function BoxCard({ lines }: { lines: string[] }) {
  const inner = lines.map(stripBoxFrame).filter((l, i, arr) => {
    // Drop blank frame rows at the edges, keep interior blanks.
    if (l !== "") return true
    return i !== 0 && i !== arr.length - 1
  })
  return (
    <div className="my-2 rounded-lg border border-line bg-surface/70 px-4 py-3">
      {inner.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: verbatim TTY lines are positional
          key={i}
          className={`whitespace-pre-wrap font-mono text-[12px] leading-relaxed ${
            /[▖▗▘▙▚▛▜▝▞▟█▌▐]/.test(line) ? "text-primary" : "text-fg/90"
          }`}
        >
          {line || " "}
        </div>
      ))}
    </div>
  )
}

function Block({ block }: { block: TtyBlock }) {
  switch (block.kind) {
    case "box":
      return <BoxCard lines={block.lines} />
    case "user":
      return (
        <div className="my-2.5 flex">
          <div className="max-w-[85%] rounded-lg border border-line bg-inset px-3 py-1.5">
            <span className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
              {block.text}
            </span>
          </div>
        </div>
      )
    case "assistant":
      return (
        <div className="my-1.5 flex gap-2.5">
          <span className="mt-[2px] shrink-0 text-[11px] text-primary">⏺</span>
          <div className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-fg/90">
            {block.lines.join("\n")}
          </div>
        </div>
      )
    case "tool":
      return (
        <div className="my-1.5 overflow-hidden rounded-md border border-line bg-surface/60">
          <div className="truncate px-2.5 py-1 font-mono text-[12px] text-fg">
            <span className="mr-1.5 text-kobe-green">⏺</span>
            {block.head}
          </div>
          {block.lines.length > 0 && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-line px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted">
              {block.lines.join("\n")}
            </pre>
          )}
        </div>
      )
    case "activity":
      return (
        <div className="my-1.5 flex items-baseline gap-2 text-[12px] italic text-primary/80">
          <span className="animate-pulse not-italic">✱</span>
          {block.text}
        </div>
      )
    case "gap":
      return <div className="h-2" />
    case "raw":
      return (
        <div className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted">
          {block.text}
        </div>
      )
  }
}

export function TtyBlocksView({ bufferText }: { bufferText: string }) {
  const blocks = useMemo(
    () => parseTtyBlocks(bufferText.split("\n")),
    [bufferText],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // Follow the live tail unless the user scrolled up (same contract as the
  // transcript view).
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks is the scroll trigger, not a read dependency.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [blocks])

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current
        if (!el) return
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      className="h-full overflow-y-auto px-4 py-3 [&>*]:mx-auto [&>*]:max-w-[860px]"
    >
      {blocks.length === 0 ? (
        <div className="py-4 text-[12px] text-subtle">
          Nothing on screen yet — the session's terminal output renders here.
        </div>
      ) : (
        blocks.map((block, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks re-derive wholesale from the buffer; position is the only identity
          <Block key={i} block={block} />
        ))
      )}
    </div>
  )
}
