/**
 * TtyBlocksView — render the TTY-translated blocks (lib/claude-tty.ts) with
 * the terminal's ANSI colors intact. Lines keep native column alignment
 * (whitespace-pre); block-art rows (the logo, boxes) render at line-height 1
 * so their cells don't split apart. The slash-command menu is rendered by
 * CommandMenu, which the shell floats just above the input row (like the
 * native TUI) rather than leaving it adrift in the scroll body.
 */

import { Fragment, useEffect, useMemo, useRef } from "react"
import {
  type MenuItem,
  parseTtyBlocks,
  type TtyBlock,
} from "../lib/claude-tty.ts"
import type { ColoredLine } from "../lib/tty-color.ts"

/** Box-drawing / block-element glyphs — rows containing them are art (logo,
 *  frames, sparklines) and must render tight so cells abut. */
const BLOCK_ART = /[█▉▊▋▌▍▎▏▀▄▐▖▗▘▙▚▛▜▝▞▟─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╱╲╳]/

/** One colored terminal line as spans. `whitespace-pre` keeps native column
 *  alignment; art rows go line-height 1 so block cells don't split. */
function Line({ line, className }: { line: ColoredLine; className?: string }) {
  const art = BLOCK_ART.test(line.text)
  return (
    <div
      className={`whitespace-pre font-mono text-[12px] ${art ? "leading-none" : "leading-[1.4]"} ${className ?? "text-fg/90"}`}
    >
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

/** The slash-command menu as a tight name/description grid. Exported so the
 *  shell can float it above the input row. */
export function CommandMenu({ items }: { items: MenuItem[] }) {
  return (
    <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-0.5">
      {items.map((item) => (
        <Fragment key={item.name}>
          <span className="font-mono text-[12px] text-primary">
            {item.name}
          </span>
          <span className="truncate font-mono text-[12px] text-muted">
            {item.desc}
          </span>
        </Fragment>
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
    case "menu":
      return (
        <div className="my-2">
          <CommandMenu items={block.items} />
        </div>
      )
    case "line":
      return <Line line={block.line} />
    case "gap":
      return <div className="h-2.5" />
  }
}

export function TtyBlocksView({ blocks }: { blocks: readonly TtyBlock[] }) {
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

/** Render a run of blocks (the live footer) inline — reuses the same Block
 *  renderer so the floated spinner/tip/menu look identical to the body. */
export function TtyFooter({ blocks }: { blocks: readonly TtyBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
        <Block key={i} block={block} />
      ))}
    </>
  )
}

/**
 * Split the LIVE FOOTER — the block run below the last gap, when it holds the
 * current turn's live state (a spinner/activity line, a slash-command menu) —
 * off the scroll body. The native TUI draws this just above the input line;
 * the shell floats it there instead of leaving it adrift in the history.
 */
export function useTtyBlocks(lines: readonly ColoredLine[]): {
  body: TtyBlock[]
  footer: TtyBlock[]
} {
  return useMemo(() => {
    const blocks = parseTtyBlocks(lines)
    let end = blocks.length
    while (end > 0 && blocks[end - 1].kind === "gap") end -= 1
    let gapIdx = -1
    for (let k = end - 1; k >= 0; k -= 1) {
      if (blocks[k].kind === "gap") {
        gapIdx = k
        break
      }
    }
    const candidate = blocks.slice(gapIdx + 1, end)
    const isLive = candidate.some(
      (b) => b.kind === "menu" || b.kind === "activity",
    )
    if (gapIdx >= 0 && isLive) {
      return { body: blocks.slice(0, gapIdx), footer: candidate }
    }
    return { body: blocks.slice(0, end), footer: [] }
  }, [lines])
}
