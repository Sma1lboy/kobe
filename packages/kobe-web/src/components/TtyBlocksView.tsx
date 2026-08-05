/**
 * TtyBlocksView — render the TTY-translated blocks (lib/claude-tty.ts) with
 * the terminal's ANSI colors intact. Every line is a run of colored spans
 * (monospace, verbatim), so a box, a slash-command menu, a diff, or a
 * banner reads exactly as the terminal drew it. The only restyle is the
 * user-prompt bubble; nothing is reimplemented.
 */

import { useEffect, useMemo, useRef } from "react"
import { parseTtyBlocks, type TtyBlock } from "../lib/claude-tty.ts"
import type { ColoredLine } from "../lib/tty-color.ts"

/** One colored terminal line as monospace spans (default fg = CSS inherit). */
function Line({ line }: { line: ColoredLine }) {
  return (
    <div className="whitespace-pre font-mono text-[12px] leading-[1.5] text-fg/90">
      {line.segs.length === 0
        ? " "
        : line.segs.map((seg, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: colored runs are positional, re-derived per frame
              key={i}
              style={seg.color ? { color: seg.color } : undefined}
            >
              {seg.text}
            </span>
          ))}
    </div>
  )
}

function Block({ block }: { block: TtyBlock }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="my-2.5 flex">
          <div className="max-w-[85%] rounded-lg border border-line bg-inset px-3 py-1.5">
            <span className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-fg">
              {block.text}
            </span>
          </div>
        </div>
      )
    case "line":
      return <Line line={block.line} />
    case "gap":
      return <div className="h-3" />
  }
}

export function TtyBlocksView({ lines }: { lines: readonly ColoredLine[] }) {
  const blocks = useMemo(() => parseTtyBlocks(lines), [lines])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // Follow the live tail unless the user scrolled up.
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
      className="h-full overflow-y-auto px-4 py-3 [&>*]:mx-auto [&>*]:max-w-[900px]"
    >
      {blocks.length === 0 ? (
        <div className="py-4 font-mono text-[12px] text-subtle">
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
