/**
 * TtyBlocksView — render the TTY-translated blocks (lib/claude-tty.ts) with
 * the terminal's ANSI colors intact. Lines keep native column alignment
 * (whitespace-pre); block-art rows (the logo, boxes) render at line-height 1
 * so their cells don't split apart. The slash-command menu is rendered by
 * CommandMenu, which the shell floats just above the input row (like the
 * native TUI) rather than leaving it adrift in the scroll body.
 */

import type { ReactNode } from "react"
import { Fragment, memo, useEffect, useRef, useState } from "react"
import type { MenuItem, OptionItem, TtyBlock } from "../lib/claude-tty.ts"
import type { EngineGrammar } from "../lib/engine-grammar.ts"
import {
  type ColoredLine,
  trimLeadingColored,
  trimTrailingColored,
} from "../lib/tty-color.ts"
import { CopyableRegion } from "./CopyableRegion.tsx"
import { UserBubble } from "./UserBubble.tsx"
import { WelcomeCard } from "./WelcomeCard.tsx"

/** Box-drawing / block-element glyphs — rows containing them are art (logo,
 *  frames, sparklines) and must render tight so cells abut. */
const BLOCK_ART = /[█▉▊▋▌▍▎▏▀▄▐▖▗▘▙▚▛▜▝▞▟─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╱╲╳]/

/** The CLI's `──── ultracode` mode divider — re-dressed as part of the
 *  ultracode ambience instead of a raw rule row. */
const ULTRA_RULE = /^─{4,}[─\s]*ultracode\s*$/

/** One colored terminal line as spans. `whitespace-pre` keeps native column
 *  alignment; art rows go line-height 1 so block cells don't split. */
function Line({
  line: raw,
  className,
}: {
  line: ColoredLine
  className?: string
}) {
  // Rows arrive padded to terminal width — trim so shrink-wrap parents work.
  const line = trimTrailingColored(raw)
  if (ULTRA_RULE.test(line.text.trim())) {
    return (
      <div className="my-1.5 flex items-center gap-2.5">
        <span aria-hidden="true" className="ultra-rule h-px min-w-0 flex-1" />
        <span className="ultra-rule__label font-mono text-[11px]">
          ultracode
        </span>
      </div>
    )
  }
  const art = BLOCK_ART.test(line.text)
  return (
    <div
      // Art rows: leading-none stitches rows vertically; the ±0.5px same-color
      // shadow fills the hairline seams fractional glyph advances leave
      // between block cells (same trick as WelcomeCard's logo).
      className={`whitespace-pre font-mono text-[12px] ${art ? "leading-none [text-shadow:0.5px_0_0_currentColor,-0.5px_0_0_currentColor]" : "leading-[1.5]"} ${className ?? "text-fg"}`}
    >
      {line.segs.length === 0
        ? " "
        : line.segs.map((seg, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: colored runs are positional, re-derived per frame
              key={i}
              style={
                seg.color || seg.bg
                  ? {
                      color: seg.color ?? undefined,
                      backgroundColor: seg.bg ?? undefined,
                    }
                  : undefined
              }
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
          {/* Selection = color only (the CLI's own grammar): bright vs grey. */}
          <span
            className={`font-mono text-[12px] ${item.selected ? "text-primary" : "text-subtle"}`}
          >
            {item.name}
          </span>
          <span
            className={`truncate font-mono text-[12px] ${item.selected ? "text-fg" : "text-subtle"}`}
          >
            {item.desc}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

/** AskUserQuestion choices as a card list, the ❯-selected one highlighted —
 *  arrow keys still drive the native selection underneath. */
function OptionMenu({ items }: { items: OptionItem[] }) {
  return (
    <div className="my-2 flex flex-col gap-1">
      {items.map((item) => (
        <div
          key={item.num}
          className={`rounded-lg border px-3 py-2 ${
            item.selected
              ? "border-primary bg-inset"
              : "border-line bg-transparent"
          }`}
        >
          <div className="flex items-baseline gap-2">
            <span
              className={`shrink-0 font-mono text-[12px] ${item.selected ? "text-primary" : "text-subtle"}`}
            >
              {item.num}.
            </span>
            <span className="text-[13px] text-fg">{item.text}</span>
          </div>
          {item.desc && (
            <div className="mt-0.5 pl-5 text-[12px] leading-relaxed text-muted">
              {item.desc}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

const BOOT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const BOOT_PHRASES = [
  "Setting up the harness…",
  "Spawning the coding agent…",
  "Wiring up the terminal…",
  "Streaming output lands here…",
] as const

// engine startup placeholder — spinner + shimmer, the CLI's boot feel.
function BootLine() {
  const spinRef = useRef<HTMLSpanElement>(null)
  const [phrase, setPhrase] = useState(0)

  useEffect(() => {
    let frame = 0
    const spin = setInterval(() => {
      frame = (frame + 1) % BOOT_FRAMES.length
      if (spinRef.current) spinRef.current.textContent = BOOT_FRAMES[frame]
    }, 80)
    const cycle = setInterval(
      () => setPhrase((i) => (i + 1) % BOOT_PHRASES.length),
      2400,
    )
    return () => {
      clearInterval(spin)
      clearInterval(cycle)
    }
  }, [])

  return (
    <div className="flex items-center gap-2 py-4 font-mono text-[12px]">
      <span ref={spinRef} className="text-primary">
        {BOOT_FRAMES[0]}
      </span>
      <span className="shimmer-text">{BOOT_PHRASES[phrase]}</span>
    </div>
  )
}

type EventKind = "response" | "user" | "activity" | "system"

/** One transcript event. The causal rail + per-event dots were dropped
 * (2026-08-07): the Agent Trace pane owns the structured timeline, so the
 * body reads as a plain conversation — rhythm comes from spacing alone. */
function TranscriptEvent({
  kind,
  children,
}: {
  kind: EventKind
  children: ReactNode
}) {
  return (
    <div className={`transcript-event transcript-event--${kind}`}>
      {children}
    </div>
  )
}

/** The CLI spinner's animation glyph — an oscillating frame, not content. */
const SPIN_GLYPH = /^[·✢✳✶✻✽✷✸✹✺✱*∗＊⠀-⣿]\s+/

function ActivityCard({ line }: { line: ColoredLine }) {
  const active = /…|\.\.\./.test(line.text)
  // Settled scrollback ("✳ Worked for 5s") reads as history, not an event —
  // a quiet line, no card chrome. Only the LIVE spinner earns the card.
  if (!active) return <Line line={line} className="py-0.5 text-subtle" />
  // Re-dress the raw spinner (`✳ Verb… (esc to interrupt · 6s · ↓ 119 tokens)`)
  // instead of echoing it: the card has its own pulse and the GUI its own
  // interrupt affordance, so the glyph, parens, and esc hint are noise here.
  const text = line.text.trim().replace(SPIN_GLYPH, "")
  const m = text.match(/^(.+?)\s*\((.*)\)$/)
  const verb = m ? m[1] : text
  const details = (m ? m[2].split("·") : [])
    .map((s) => s.trim())
    .filter((s) => s !== "" && !/esc to interrupt/i.test(s))
  // Bare row — the footer card already draws the frame; a small primary
  // pulse + the shimmering verb say "working" without a label.
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <span
        className="activity-card__pulse shrink-0 text-primary"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-[12px]">
        <span className="shimmer-text">{verb}</span>
        {details.map((d) => (
          <span key={d} className="whitespace-nowrap text-subtle">
            {d}
          </span>
        ))}
      </div>
    </div>
  )
}

function Block({
  block,
  sessionId,
}: {
  block: TtyBlock
  sessionId: string | null
}) {
  switch (block.kind) {
    case "user":
      return <UserBubble text={block.text} sessionId={sessionId} />
    case "activity":
      return <ActivityCard line={block.line} />
    case "menu":
      return (
        <div className="my-2">
          <CommandMenu items={block.items} />
        </div>
      )
    case "options":
      return <OptionMenu items={block.items} />
    case "welcome":
      return <WelcomeCard welcome={block.welcome} />
    case "recap":
      // Normally lifted + pinned above the composer by the shell; anywhere
      // else (older scrollback) it reads as a quiet summary line.
      return (
        <div className="py-0.5 text-[12px] leading-relaxed text-subtle">
          ※ {block.text}
        </div>
      )
    case "line":
      return <Line line={block.line} />
    case "gap":
      return <div className="h-2.5" />
  }
}

/** memo'd: the parse cache keeps `blocks` referentially stable across input
 *  keystrokes, so the whole transcript subtree skips re-render. */
export const TtyBlocksView = memo(function TtyBlocksView({
  blocks,
  sessionId,
}: {
  blocks: readonly TtyBlock[]
  sessionId: string | null
}) {
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
        <BootLine />
      ) : (
        // Settled spinner summaries ("✳ Cooked for 5s") are timing residue,
        // not conversation — drop them from the body entirely. The LIVE
        // spinner still shows in the footer.
        groupCopyRuns(
          blocks.filter(
            (b) => b.kind !== "activity" || /…|\.\.\./.test(b.line.text),
          ),
        ).map((item, i) =>
          item.kind === "run" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks re-derive wholesale from the buffer; position is the only identity
            <TranscriptEvent key={i} kind="response">
              <CopyableRegion text={item.text}>
                {item.blocks.map((block, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional within the run
                  <Block key={j} block={block} sessionId={sessionId} />
                ))}
              </CopyableRegion>
            </TranscriptEvent>
          ) : (
            <TranscriptSingle
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks re-derive wholesale from the buffer; position is the only identity
              key={i}
              block={item.block}
              sessionId={sessionId}
            />
          ),
        )
      )}
    </div>
  )
})

type CopyRunItem =
  | { kind: "run"; blocks: TtyBlock[]; text: string }
  | { kind: "single"; block: TtyBlock }

function eventKindFor(block: TtyBlock): EventKind {
  if (block.kind === "user") return "user"
  if (block.kind === "activity") return "activity"
  if (
    block.kind === "welcome" ||
    block.kind === "menu" ||
    block.kind === "options"
  ) {
    return "system"
  }
  return "response"
}

function TranscriptSingle({
  block,
  sessionId,
}: {
  block: TtyBlock
  sessionId: string | null
}) {
  // Whitespace separates events; it is not an event itself and should not
  // create an empty stop on the rail.
  if (block.kind === "gap") return <Block block={block} sessionId={sessionId} />
  return (
    <TranscriptEvent kind={eventKindFor(block)}>
      <Block block={block} sessionId={sessionId} />
    </TranscriptEvent>
  )
}

/** Chunk consecutive plain line/gap blocks into hover-copyable runs — the
 *  assistant prose between structural blocks (bubbles, menus, cards). */
export function groupCopyRuns(blocks: readonly TtyBlock[]): CopyRunItem[] {
  const out: CopyRunItem[] = []
  let run: TtyBlock[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const text = run
      // Copy the prose, not the terminal dressing: drop the `● ` bullet and
      // its matching 2-space continuation indent (deeper indents survive).
      .map((b) =>
        b.kind === "line"
          ? b.line.text.replace(/^[●⏺]\s/, "").replace(/^ {2}/, "")
          : "",
      )
      .join("\n")
      .replace(/^\n+|\n+$/g, "")
    if (text.trim() === "")
      out.push(...run.map((b) => ({ kind: "single" as const, block: b })))
    else out.push({ kind: "run", blocks: run, text })
    run = []
  }
  for (const block of blocks) {
    if (block.kind === "line" || block.kind === "gap") run.push(block)
    else {
      flush()
      out.push({ kind: "single", block })
    }
  }
  flush()
  return out
}

/** Render a run of blocks (the live footer) inline — reuses the same Block
 *  renderer so the floated spinner/tip/menu look identical to the body. */
export const TtyFooter = memo(function TtyFooter({
  blocks,
  sessionId,
}: {
  blocks: readonly TtyBlock[]
  sessionId: string | null
}) {
  return (
    <>
      {blocks.map((block, i) => {
        // The CLI space-pads footer lines (tips, clipboard hint) to right-
        // align at ITS cols — strip the padding and keep everything on the
        // LEFT, in line with the spinner, so the card reads as one column.
        if (block.kind === "line" && /^ {2,}\S/.test(block.line.text)) {
          return (
            <Block
              // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
              key={i}
              block={{ kind: "line", line: trimLeadingColored(block.line) }}
              sessionId={sessionId}
            />
          )
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
          <Block key={i} block={block} sessionId={sessionId} />
        )
      })}
    </>
  )
})

/**
 * Split the LIVE FOOTER — the block run below the last gap, when it holds the
 * current turn's live state (a spinner/activity line, a slash-command menu) —
 * off the scroll body. The native TUI draws this just above the input line;
 * the shell floats it there instead of leaving it adrift in the history.
 */
/** Ephemeral notices the native draws just above the prompt (clipboard hint,
 *  paste receipts, usage-limit warnings) — they belong by the input, not
 *  adrift in history. */
const INPUT_HINT =
  /clipboard|ctrl\+v|to paste|pasted\b|\[image #|% of your \S+ limit|\/upgrade to keep using/i

export function useTtyBlocks(
  lines: readonly ColoredLine[],
  grammar: Pick<EngineGrammar, "parseBlocks">,
): {
  body: TtyBlock[]
  footer: TtyBlock[]
} {
  // Parse cache keyed by ELEMENT identity: the frame stabilizer reuses line
  // objects for unchanged rows, so a keystroke that only redraws the input
  // region skips the parse AND returns the previous body/footer wholesale —
  // memoized views then skip re-render too.
  const cacheRef = useRef<{
    lines: readonly ColoredLine[]
    grammar: Pick<EngineGrammar, "parseBlocks">
    result: { body: TtyBlock[]; footer: TtyBlock[] }
  } | null>(null)
  const cached = cacheRef.current
  if (
    cached &&
    cached.grammar === grammar &&
    cached.lines.length === lines.length &&
    cached.lines.every((l, i) => l === lines[i])
  ) {
    return cached.result
  }
  const result = (() => {
    const blocks = grammar.parseBlocks(lines)
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
    // Only an IN-PROGRESS activity (a spinner, marked by its `…`) is live and
    // floats by the input. A finished summary (`✱ Cogitated for 7s`) is history
    // and stays in the scroll body.
    const isLive = candidate.some(
      (b) =>
        b.kind === "menu" ||
        b.kind === "options" ||
        (b.kind === "activity" && /[…]|\.\.\./.test(b.line.text)),
    )
    let footer: TtyBlock[] = []
    let bodyEnd = end
    if (gapIdx >= 0 && isLive) {
      footer = candidate
      bodyEnd = gapIdx
    }
    // Pull any trailing input-adjacent hint lines (clipboard notice, etc.)
    // off the body into the footer so they sit by the input, not in history.
    const bodyBlocks = blocks.slice(0, bodyEnd)
    while (bodyBlocks.length > 0) {
      const tail = bodyBlocks[bodyBlocks.length - 1]
      if (tail.kind === "gap") {
        bodyBlocks.pop()
      } else if (tail.kind === "line" && INPUT_HINT.test(tail.line.text)) {
        footer.unshift(bodyBlocks.pop() as TtyBlock)
      } else break
    }
    return { body: bodyBlocks, footer }
  })()
  cacheRef.current = { lines, grammar, result }
  return result
}
