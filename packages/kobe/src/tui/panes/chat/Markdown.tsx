/**
 * Tiny markdown renderer for the chat pane — Claude-Code-shape parity.
 *
 * Why hand-rolled (not `marked`):
 *
 *   - Brief explicitly forbids new dependencies. opentui ships its own
 *     `<markdown>` renderable but it pulls in tree-sitter + a full
 *     SyntaxStyle setup and emits its own boxes; threading that through
 *     the chat pane's flex flow is heavier than what we need.
 *   - We cover the shapes Claude Code's assistant turns actually
 *     produce. Block: paragraph, ATX heading (`#` ../`######`), ordered
 *     and unordered lists (incl. GFM task lists), blockquote (`> ...`),
 *     fenced code, horizontal rules (`---`/`***`/`___`), and GFM tables.
 *     Inline: bold (`**`), italic (`*` / `_`), inline code, link
 *     (`[text](href)`), bare-URL autolink (http/https). Strikethrough is
 *     deliberately disabled — claude-code does the same because the
 *     model uses `~100` to mean "approximately"; nested lists still
 *     deferred (parser-invasive, low payoff for assistant output).
 *
 * Design:
 *
 *   - {@link parseBlocks}: splits the input into a list of block tokens
 *     (paragraph, heading, list, blockquote, code, hr, table). Pure.
 *   - {@link parseInline}: tokenizes a paragraph string into inline
 *     spans (text, bold, italic, code, link). Also pure.
 *   - {@link Markdown}: opentui-Solid component that renders a block
 *     list as `<box>`/`<text>` children using opentui's `<b>`, `<em>`,
 *     `<span>` text-node primitives for inline formatting.
 *
 * Inline matching note: opentui supports `<b>` / `<em>` text nodes that
 * apply BOLD / ITALIC attributes inside a `<text>` parent. We use those
 * directly so wrapping behavior matches plain text — no custom attribute
 * masks, no per-segment `<text>` sibling stacking (which would force
 * line breaks in opentui's box flow).
 *
 * Streaming-friendly: the renderer is called every time the assistant
 * row's text grows by a delta. The block tokenizer is bounded-cost
 * (O(n) over the full string per render); for typical assistant turns
 * (under ~5 KB) this is sub-ms. If/when streams get very long we can
 * cache per row id, but the brief says "within reason" and the chat
 * tests render small fixtures.
 */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import { EmptyBorder } from "../../component/border"
import { useTheme } from "../../context/theme"
import { type Block, type Inline, type TableAlign, inlinePlainText, parseBlocks, parseInline } from "./markdown-parser"

// Re-export the parser surface so callers see one import per concern.
export { parseBlocks, parseInline }
export type { Block, Inline }

/**
 * Render an inline token list inside a `<text>` parent. We use
 * opentui's `<b>` / `<em>` text-node primitives, which apply the
 * BOLD / ITALIC attribute mask without breaking the flow. Inline code
 * gets a `<span>` with a backgrounded fg-flipped color (mirrors how
 * Claude Code's Markdown formats `code` — dim, monospace-feeling).
 */
function InlineSpans(props: { tokens: Inline[] }) {
  const { theme } = useTheme()
  return (
    <For each={props.tokens}>
      {(t) => {
        if (t.kind === "bold") return <b>{t.text}</b>
        if (t.kind === "italic") return <em>{t.text}</em>
        if (t.kind === "code") {
          // Inline code: muted bg + accent fg — readable contrast at any
          // theme. We deliberately don't use a true bg block ("` x `")
          // because that fights the parent text's background.
          return <span style={{ fg: theme.accent, attributes: TextAttributes.DIM }}>`{t.text}`</span>
        }
        if (t.kind === "link") {
          // opentui has no OSC 8 plumbing, so we render the display text
          // underlined+accent and emit the URL parenthesised+dim after it
          // when it differs. When text==href we just print the href once.
          const showUrl = t.text.length > 0 && t.text !== t.href
          return (
            <>
              <span style={{ fg: theme.accent, attributes: TextAttributes.UNDERLINE }}>
                {showUrl ? t.text : t.href}
              </span>
              <Show when={showUrl}>
                <span style={{ fg: theme.textMuted, attributes: TextAttributes.DIM }}> ({t.href})</span>
              </Show>
            </>
          )
        }
        return <span>{t.text}</span>
      }}
    </For>
  )
}

/**
 * Pad a string to `width` cells of plain-text width using the supplied
 * alignment. The padding is added as plain spaces around the content;
 * the *content* itself is rendered via InlineSpans so formatting
 * (bold/italic/code/link) survives the trip through the table cell.
 *
 * Returns `[leftPad, rightPad]` in cell counts. Caller emits spaces
 * between the cell value and the column border. This keeps the table
 * algorithm independent of how the cell happens to render markup.
 */
function padding(plainWidth: number, columnWidth: number, align: TableAlign): [number, number] {
  const slack = Math.max(0, columnWidth - plainWidth)
  if (align === "right") return [slack, 0]
  if (align === "center") {
    const left = Math.floor(slack / 2)
    return [left, slack - left]
  }
  return [0, slack]
}

/**
 * Render a GFM table.
 *
 * Width algorithm (port of claude-code's MarkdownTable, simplified):
 *   1. For each column compute idealWidth (plain-text width of widest cell).
 *   2. If sum(ideals) + borders fits the budget, use ideals.
 *   3. Otherwise scale down proportionally to a per-column minimum (3).
 *
 * Wrapping is intentionally NOT supported in this first cut — if any cell
 * still overflows after scaling we fall back to a vertical "label: value"
 * format. Claude Code's table renderer wraps cell content with ANSI-aware
 * line-breaking; that path needs `wrapAnsi` + a multi-line cell layout
 * that opentui doesn't model natively. Skipping it keeps this under 100
 * lines and covers the 90% case (tables with short cells).
 *
 * Width budget defaults to `terminalWidth - 50` to account for sidebar
 * (~42), splitters, and the assistant-row glyph indent. Callers can
 * override via Markdown's `maxWidth` prop when they have a tighter
 * measurement.
 */
function Table(props: { block: Extract<Block, { kind: "table" }>; maxWidth?: number }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()

  const cellTokens = (raw: string) => parseInline(raw)
  const cellWidth = (raw: string) => Array.from(inlinePlainText(parseInline(raw))).length

  const numCols = props.block.header.length
  const idealWidths = props.block.header.map((h, ci) => {
    let w = cellWidth(h)
    for (const r of props.block.rows) w = Math.max(w, cellWidth(r[ci] ?? ""))
    return Math.max(3, w)
  })
  // Border overhead: leading │, then per column " <content> │" = 3 extra cells.
  const borderOverhead = 1 + numCols * 3
  const widthBudget = Math.max(20, (props.maxWidth ?? dims().width - 50) - borderOverhead)
  const totalIdeal = idealWidths.reduce((a, b) => a + b, 0)

  let columnWidths = idealWidths
  if (totalIdeal > widthBudget) {
    const scale = widthBudget / totalIdeal
    columnWidths = idealWidths.map((w) => Math.max(3, Math.floor(w * scale)))
  }

  // If any cell's plain text still exceeds its column width, fall back to
  // vertical format. This handles tables whose content can't fit even at
  // idealWidth (a long URL in a narrow terminal); rendering them
  // horizontally would either truncate (data loss) or wrap mid-cell
  // (visually broken with our string-line model).
  const overflowsHorizontal = (() => {
    for (let ci = 0; ci < numCols; ci++) {
      if (cellWidth(props.block.header[ci] ?? "") > columnWidths[ci]!) return true
      for (const r of props.block.rows) {
        if (cellWidth(r[ci] ?? "") > columnWidths[ci]!) return true
      }
    }
    return false
  })()

  if (overflowsHorizontal) {
    return <VerticalTable block={props.block} />
  }

  const renderBorder = (kind: "top" | "mid" | "bot") => {
    const [l, m, c, r] =
      kind === "top" ? ["┌", "─", "┬", "┐"] : kind === "mid" ? ["├", "─", "┼", "┤"] : ["└", "─", "┴", "┘"]
    let line = l
    for (let i = 0; i < columnWidths.length; i++) {
      line += m.repeat(columnWidths[i]! + 2)
      line += i < columnWidths.length - 1 ? c : r
    }
    return line
  }

  const Row = (rowProps: { cells: string[]; isHeader: boolean }) => (
    <text fg={theme.text}>
      {"│"}
      <For each={rowProps.cells}>
        {(cell, ci) => {
          const tokens = cellTokens(cell)
          const align = rowProps.isHeader ? "center" : (props.block.align[ci()] ?? "left")
          const [lp, rp] = padding(cellWidth(cell), columnWidths[ci()] ?? 0, align)
          return (
            <>
              <span>{` ${" ".repeat(lp)}`}</span>
              {rowProps.isHeader ? (
                <b>
                  <InlineSpans tokens={tokens} />
                </b>
              ) : (
                <InlineSpans tokens={tokens} />
              )}
              <span>{`${" ".repeat(rp)} │`}</span>
            </>
          )
        }}
      </For>
    </text>
  )

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text fg={theme.textMuted}>{renderBorder("top")}</text>
      <Row cells={props.block.header} isHeader={true} />
      <text fg={theme.textMuted}>{renderBorder("mid")}</text>
      <For each={props.block.rows}>
        {(r, ri) => (
          <>
            <Row cells={r} isHeader={false} />
            <Show when={ri() < props.block.rows.length - 1}>
              <text fg={theme.textMuted}>{renderBorder("mid")}</text>
            </Show>
          </>
        )}
      </For>
      <text fg={theme.textMuted}>{renderBorder("bot")}</text>
    </box>
  )
}

/**
 * Vertical fallback for tables that don't fit horizontally — emits each
 * row as a stack of `**Header:** value` lines with a thin separator
 * between rows. Mirrors claude-code's MarkdownTable vertical branch.
 */
function VerticalTable(props: { block: Extract<Block, { kind: "table" }> }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <For each={props.block.rows}>
        {(row, ri) => (
          <>
            <Show when={ri() > 0}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                ────────────────────────────────────────
              </text>
            </Show>
            <For each={row}>
              {(cell, ci) => (
                <text fg={theme.text}>
                  <b style={{ fg: theme.accent }}>{`${props.block.header[ci()] ?? `Column ${ci() + 1}`}: `}</b>
                  <InlineSpans tokens={parseInline(cell)} />
                </text>
              )}
            </For>
          </>
        )}
      </For>
    </box>
  )
}

/** Horizontal rule. A flex-stretched single-line top border on a 1-cell-tall
 *  box renders as a `─` run that fills whatever width the parent gives us. */
function HorizontalRule() {
  const { theme } = useTheme()
  return (
    <box paddingTop={1} paddingBottom={1} flexDirection="column">
      <box
        height={1}
        border={["top"]}
        borderColor={theme.textMuted}
        customBorderChars={{ ...EmptyBorder, horizontal: "─" }}
      />
    </box>
  )
}

/**
 * Render a single block. Layout follows Claude Code's conventions:
 *
 *   - Paragraph: single `<text>` line (with inline spans). Wraps
 *     naturally per opentui's word-wrap.
 *   - List: a column of `<text>` rows, each prefixed by a dim `•`.
 *     GFM task-list items show a `[x]` / `[ ]` checkbox in the prefix
 *     instead of the bullet, with the label dimmed when checked.
 *   - Code block: a column of muted-fg `<text>` lines inside a
 *     padded box. We don't syntax-highlight (that's a heavier port);
 *     fenced code is shown verbatim with an `accent`-colored language
 *     hint above it when present, mirroring how Claude Code labels
 *     fenced blocks.
 *   - Table: bordered box-drawing layout (or vertical fallback when
 *     content overflows). See {@link Table}.
 *   - HR: dim horizontal line stretched to the parent's width.
 */
function BlockNode(props: { block: Block; maxWidth?: number }) {
  const { theme } = useTheme()
  const b = props.block
  if (b.kind === "paragraph") {
    const tokens = parseInline(b.text)
    // Fast path: pure plain text (no inline markup) renders as a bare
    // `<text>{string}</text>`. Routing through `<InlineSpans>` for plain
    // text triggered an opentui rendering bug that ate the second
    // character (`hello` → `hllo`) when the body box was wrapped in a
    // flex-row with a wide-glyph prefix sibling. Skipping the span
    // wrapper preserves the chars and shaves a render layer.
    if (tokens.length === 1 && tokens[0]?.kind === "text") {
      return <text fg={theme.text}>{tokens[0].text}</text>
    }
    return (
      <text fg={theme.text}>
        <InlineSpans tokens={tokens} />
      </text>
    )
  }
  if (b.kind === "heading") {
    // H1 → bold + underline; H2 → bold + accent; H3+ → bold.
    // Mirrors claude-code's `formatToken` heading branch (h1 underlines,
    // h2/h3 just bold) with a TUI-friendly accent for h2 instead of
    // italic-underline (italic ≠ readable on every terminal font).
    const attrs = b.level === 1 ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.BOLD
    const fg = b.level <= 2 ? theme.accent : theme.text
    const tokens = parseInline(b.text)
    return (
      <text fg={fg} attributes={attrs}>
        <InlineSpans tokens={tokens} />
      </text>
    )
  }
  if (b.kind === "list") {
    return (
      <box flexDirection="column">
        <For each={b.items}>
          {(item, idx) => {
            const isTask = item.checked !== undefined
            const checkbox = item.checked ? "[x] " : "[ ] "
            const bullet = b.ordered ? `${b.start + idx()}. ` : "• "
            const prefix = isTask ? checkbox : bullet
            // Checked task items: dim the label so the eye lands on the
            // remaining work, matching how most TUI todo apps render it.
            const labelAttrs = isTask && item.checked ? TextAttributes.DIM : 0
            return (
              <text fg={theme.text} attributes={labelAttrs}>
                <span style={{ fg: isTask && item.checked ? theme.accent : theme.textMuted }}>{prefix}</span>
                <InlineSpans tokens={parseInline(item.text)} />
              </text>
            )
          }}
        </For>
      </box>
    )
  }
  if (b.kind === "blockquote") {
    // Dim vertical bar + italic body, matching claude-code's
    // `blockquote` formatToken branch (BLOCKQUOTE_BAR `▍` + chalk.italic).
    return (
      <box flexDirection="column">
        <For each={b.lines}>
          {(line) => (
            <text fg={theme.textMuted} attributes={TextAttributes.ITALIC}>
              <span style={{ fg: theme.textMuted, attributes: TextAttributes.DIM }}>▍ </span>
              <InlineSpans tokens={parseInline(line)} />
            </text>
          )}
        </For>
      </box>
    )
  }
  if (b.kind === "hr") {
    return <HorizontalRule />
  }
  if (b.kind === "table") {
    return <Table block={b} maxWidth={props.maxWidth} />
  }
  // code block
  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2}>
      <Show when={b.lang}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
          {b.lang}
        </text>
      </Show>
      <For each={b.lines}>{(line) => <text fg={theme.accent}>{line}</text>}</For>
    </box>
  )
}

/**
 * Render markdown source as a vertical column of blocks. Used by the
 * assistant message row to give Claude's responses the same shape they
 * have in Claude Code: paragraphs flow as text, code blocks indent and
 * dim, lists bullet-prefix.
 *
 * `maxWidth` — optional cap (in cells) that the table renderer uses for
 * column-width planning. Callers that know their available width
 * (workspace pane) should pass it; otherwise the table falls back to
 * `terminalWidth - 50` to cover the standard 5-pane layout (sidebar 42
 * + splitter + padding).
 *
 * Empty input → no children (the parent should already gate on
 * `text.length > 0` to avoid an empty box, but we don't emit blank
 * placeholders either way).
 */
export function Markdown(props: { source: string; maxWidth?: number }) {
  return (
    <box flexDirection="column">
      <For each={parseBlocks(props.source)}>{(block) => <BlockNode block={block} maxWidth={props.maxWidth} />}</For>
    </box>
  )
}
