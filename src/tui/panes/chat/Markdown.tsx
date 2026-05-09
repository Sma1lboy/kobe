/**
 * Tiny markdown renderer for the chat pane — Claude-Code-shape parity.
 *
 * Why hand-rolled (not `marked`):
 *
 *   - Brief explicitly forbids new dependencies. opentui ships its own
 *     `<markdown>` renderable but it pulls in tree-sitter + a full
 *     SyntaxStyle setup and emits its own boxes; threading that through
 *     the chat pane's flex flow is heavier than what we need.
 *   - We only cover the four shapes Claude Code's assistant turns
 *     actually produce in 95% of cases:
 *       1. Inline code          — `code`
 *       2. Bold                 — **text**
 *       3. Bullet lists         — leading `- ` per line
 *       4. Fenced code blocks   — ```lang ... ```
 *     Italic (single `*`) is also supported (cheap to add) and matches
 *     Claude Code's `<em>` rendering. Links / tables / blockquotes are
 *     deferred — Claude Code's own `Markdown.tsx` defers them to a
 *     fast-path too when no syntax marker is present.
 *
 * Design:
 *
 *   - {@link parseBlocks}: splits the input into a list of block tokens
 *     (paragraph, list, code-fence). Pure, easy to test.
 *   - {@link parseInline}: tokenizes a paragraph string into inline
 *     spans (text, bold, italic, code). Also pure.
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

/** Block-level token. The renderer maps these 1:1 to JSX. */
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; lang: string; lines: string[] }

/** Inline-level token. Used inside paragraphs and list items. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }

/**
 * Split markdown source into block-level tokens.
 *
 * Recognized blocks (in priority order):
 *
 *   1. Fenced code: a line starting with ``` (optionally followed by a
 *      lang ident) opens a code block. Subsequent lines accumulate
 *      until the next ``` line. If EOF arrives without a close, the
 *      block stays open (streaming case — we still render what we
 *      have).
 *   2. List: contiguous lines starting with `- ` or `* ` collapse into
 *      one list block. Indentation isn't tracked — just flat lists.
 *   3. Paragraph: everything else. Consecutive non-blank, non-list,
 *      non-fence lines join with `\n` into one paragraph.
 *
 * Blank lines separate paragraphs. We don't emit a separate "blank"
 * token; the renderer's per-block top margin gives visual spacing.
 */
export function parseBlocks(src: string): Block[] {
  const lines = src.split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ""
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "")
        i++
      }
      // Skip the closing fence (if present).
      if (i < lines.length) i++
      blocks.push({ kind: "code", lang, lines: codeLines })
      continue
    }
    // List item.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""))
        i++
      }
      blocks.push({ kind: "list", items })
      continue
    }
    // Blank line — paragraph separator. Skip.
    if (line.trim() === "") {
      i++
      continue
    }
    // Paragraph: gather contiguous non-blank, non-list, non-fence lines.
    const paraLines: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ""
      if (l.trim() === "") break
      if (/^\s*[-*]\s+/.test(l)) break
      if (/^```/.test(l)) break
      paraLines.push(l)
      i++
    }
    blocks.push({ kind: "paragraph", text: paraLines.join("\n") })
  }
  return blocks
}

/**
 * Tokenize a paragraph (or list item) into inline spans.
 *
 * Recognized markers (in priority order; first match wins per position):
 *
 *   - `` `code` ``        — inline code (no nesting; raw text inside)
 *   - `**bold**`          — bold (no nested asterisks expected)
 *   - `*italic*` or `_italic_` — italic (no nested underscores)
 *
 * Unmatched / mismatched markers fall back to plain text — better to
 * render Claude's literal `**` than to throw or hide the content.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ""
  let i = 0
  const flushBuf = () => {
    if (buf.length > 0) {
      out.push({ kind: "text", text: buf })
      buf = ""
    }
  }
  while (i < src.length) {
    const ch = src[i]
    // Inline code: scan for the next backtick.
    if (ch === "`") {
      const end = src.indexOf("`", i + 1)
      if (end > i) {
        flushBuf()
        out.push({ kind: "code", text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
      // Unmatched backtick — fall through as literal.
    }
    // Bold: **text**.
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2)
      if (end > i + 1) {
        flushBuf()
        out.push({ kind: "bold", text: src.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }
    // Italic: *text* or _text_. Single `*` only (we already handled `**`).
    if (ch === "*" || ch === "_") {
      // Don't catch `**` here (handled above) — if we got past that
      // case, it's a single marker.
      const end = src.indexOf(ch, i + 1)
      if (end > i && /\S/.test(src.slice(i + 1, end))) {
        flushBuf()
        out.push({ kind: "italic", text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flushBuf()
  return out
}

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
  if (b.kind === "list") {
    return (
      <box flexDirection="column">
        <For each={b.items}>
          {(item) => (
            <text fg={theme.text}>
              <span style={{ fg: theme.textMuted }}>• </span>
              <InlineSpans tokens={parseInline(item)} />
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
