/**
 * TtyBlocksView — render the TTY-translated blocks (lib/claude-tty.ts) with
 * the terminal's ANSI colors intact. Lines wrap (whitespace-pre-wrap) rather
 * than clip, so a wide slash-command menu or long tool output never loses
 * content off the right edge. The only restyle: user echoes as bubbles,
 * activity lines quieted. Nothing is reimplemented — it's the terminal's own
 * output, re-laid-out and colored.
 */

import { useEffect, useMemo, useRef } from "react"
import { parseTtyBlocks, type TtyBlock } from "../lib/claude-tty.ts"
import type { ColoredLine } from "../lib/tty-color.ts"

/** One colored terminal line as spans. `whitespace-pre` keeps the native
 *  column alignment (menus, diffs, boxes); the hidden PTY is sized a touch
 *  narrower than this column so a native line always fits — no wrap, no clip.
 *  Default fg falls through to CSS (the row's text color). */
function Line({ line, className }: { line: ColoredLine; className?: string }) {
  return (
    <div
      className={`whitespace-pre font-mono text-[12px] leading-[1.55] ${className ?? "text-fg/90"}`}
    >
      {line.segs.length === 0
        ? " "
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
        <div className="my-3 flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-inset px-3.5 py-2">
            <span className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-fg">
              {block.text}
            </span>
          </div>
        </div>
      )
    case "activity":
      return <Line line={block.line} className="text-subtle/70 italic" />
    case "line":
      return <Line line={block.line} />
    case "gap":
      return <div className="h-2.5" />
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
      className="h-full overflow-x-hidden overflow-y-auto px-4 py-4"
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
