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
 *     and unordered lists, blockquote (`> ...`), fenced code. Inline:
 *     bold (`**`), italic (`*` / `_`), inline code, link
 *     (`[text](href)`). Tables, nested lists, images, and strikethrough
 *     are deliberately deferred — claude-code itself disables `~`
 *     strikethrough (the model uses `~100` for "approximately"), and
 *     tables need real flexbox layout (their <Markdown> uses a separate
 *     React component for that).
 *
 * Design:
 *
 *   - {@link parseBlocks}: splits the input into a list of block tokens
 *     (paragraph, heading, list, blockquote, code-fence). Pure.
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
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { type Block, type Inline, parseBlocks, parseInline } from "./markdown-parser"

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
              <span style={{ fg: theme.accent, attributes: TextAttributes.UNDERLINE }}>{showUrl ? t.text : t.href}</span>
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
 * Render a single block. Layout follows Claude Code's conventions:
 *
 *   - Paragraph: single `<text>` line (with inline spans). Wraps
 *     naturally per opentui's word-wrap.
 *   - List: a column of `<text>` rows, each prefixed by a dim `•`.
 *     Claude Code uses `•` for list markers in TUI output (Ink's
 *     `<Markdown>` does the same when rendering bullet lists).
 *   - Code block: a column of muted-fg `<text>` lines inside a
 *     padded box. We don't syntax-highlight (that's a heavier port);
 *     fenced code is shown verbatim with an `accent`-colored language
 *     hint above it when present, mirroring how Claude Code labels
 *     fenced blocks.
 */
function BlockNode(props: { block: Block }) {
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
    const attrs =
      b.level === 1
        ? TextAttributes.BOLD | TextAttributes.UNDERLINE
        : TextAttributes.BOLD
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
          {(item, idx) => (
            <text fg={theme.text}>
              <span style={{ fg: theme.textMuted }}>{b.ordered ? `${b.start + idx()}. ` : "• "}</span>
              <InlineSpans tokens={parseInline(item)} />
            </text>
          )}
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
 * Empty input → no children (the parent should already gate on
 * `text.length > 0` to avoid an empty box, but we don't emit blank
 * placeholders either way).
 */
export function Markdown(props: { source: string }) {
  return (
    <box flexDirection="column">
      <For each={parseBlocks(props.source)}>{(block) => <BlockNode block={block} />}</For>
    </box>
  )
}
