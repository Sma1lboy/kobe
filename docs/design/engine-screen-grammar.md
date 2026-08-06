# Engine screen grammar — porting a coding agent into the /chat translated render

The `/chat` shell drives the REAL vendor CLI in a PTY and translates its
screen into GUI blocks. The vendor-specific knowledge lives behind ONE
interface — `packages/kobe-web/src/lib/engine-grammar.ts` — and this page is
the porting guide for adding the next agent (written after shipping Claude
Code and Codex). Everything else (PTY plumbing, colored-buffer capture, IME
and cursor mirroring, copy affordances, perf caches, raw-terminal fallback)
is engine-agnostic and comes for free.

## The contract

```ts
interface EngineGrammar {
  findInputRegion(lines): InputRegion | null // where is the composer?
  parseBlocks(lines): TtyBlock[]             // lines → bubbles/menus/cards
  exitBanner: RegExp | null                  // "session over" text, if any
  effortLine: RegExp | null                  // right-aligned chip to lift out
}
```

Register the grammar in `grammarFor()`. **Unknown vendors fall back to
`rawGrammar`** — the shell shows a plain terminal, so a missing grammar is a
missing enhancement, never a broken session. Ship the raw mode first, add
grammar rules incrementally.

## How to sample a vendor's screen (do this before writing any rule)

1. Spawn the CLI in a scratch PTY and capture raw bytes (python `pty.fork`,
   ~5s, send keys between captures — see the technique below). Feed the bytes
   through `pyte` to render the final screen grid at each checkpoint.
2. Checkpoints worth capturing: cold boot (welcome), the composer at rest,
   the slash/command menu open, a selection prompt, text typed into the
   composer, and — if cheap — one user↔assistant exchange and the exit
   banner (Ctrl-C).
3. For COLOR semantics (selection highlight), sample through the app itself:
   attach the vendor in a sandbox tab and dump `ColoredLine[]` (a temporary
   `window.__coloredDebug = colored` probe in SessionView), because pyte
   won't tell you which runs are chromatic vs grey.

## Rules of thumb (each of these was a shipped bug for Claude)

- **Prompt glyphs cluster.** `❯ › > )` all mean "composer" across today's
  CLIs — `findClaudeInputRegion` already matches the family, which is why
  Codex needed zero new region code. Guard against the selection cursor:
  `› 1. Option` is a menu cursor, not the composer.
- **Color IS semantics.** Claude marks the selected menu row with a
  CHROMATIC name color vs grey (not inverse video). Detect "chromatic" by
  channel spread (>16), not exact color values — themes change. Capture the
  BACKGROUND channel too; some widgets do use inverse video.
- **Right-alignment is space padding.** Anything the CLI right-aligns
  (effort chip, clipboard hint) is padded to ITS columns; strip the spaces
  and re-align with CSS or it clips/misplaces at any other width.
- **Multi-line user echo has continuation grammar.** Claude: `> line1` then
  2-space-indented continuations (internal blank lines allowed). Only
  matching the first line shatters messages.
- **Exit banner position matters.** Banner BELOW the current input box =
  stale box (engine died); ABOVE it = the engine was relaunched in the same
  shell. Get this wrong and re-running the engine in a shell tab sticks in
  raw mode.
- **Width-match the hidden terminal** to the translated column (same
  horizontal padding) so the CLI's own wrapping/ellipsis maps 1:1.
- **Trim trailing whitespace before render.** Terminal rows are padded to
  full width; the padding defeats `w-fit` layouts and bloats copied text.
- **Perf = referential stability.** Unchanged rows keep their object
  identity across frames (`sameColoredLine` stabilizer) → the element-keyed
  parse cache in `useTtyBlocks` skips work → memoized views skip re-render.
  A keystroke should only re-render the composer mirror.
- **Verify in isolation.** Never drive a real user session: agent-browser /
  sandbox homes only. Kill the throwaway PTYs (`/pty/close`) afterwards.
- **Menus can live BELOW the composer.** Claude draws the slash menu above
  the prompt; Codex draws it below. A short tail window (8 rows) loses the
  prompt the instant the menu opens → the whole screen falls back to raw
  mode. Codex uses a 14-row window and the shell splits below-composer rows
  into status vs `isMenuRow()` lines, floating the menu into the footer
  (`findCodexInputRegion` + the `belowMenu` split in `ChatShell.tsx`).
- **Box frames are re-layout candidates, not sacred.** Codex's boxed
  welcome (`│ >_ OpenAI Codex (v0.146.0) │`) folds into the same
  `WelcomeCard` as Claude's block art; its update-available box becomes the
  card's right-column `notice` (`WelcomeInfo.notice`) — most users never
  see one, so the card stays single-column. Parse boxes generically
  (`findBoxes` in `codex-tty.ts`), classify by inner text, splice the
  ranges out.
- **Vendor extras gate on `WelcomeInfo.vendor`.** The What's-new changelog
  column is Claude-only; other vendors get the single-column card unless
  they bring their own right-column content.

## Vendor cheat sheet (sampled)

| | Claude Code v2.1 | Codex CLI v0.146 |
|---|---|---|
| Composer | `❯ ` between `───` rules | `› ` no rules, blank-line framed |
| Status tail | branch \| ctx \| quota rows | `model · directory` row |
| Assistant marker | `● ` bullets, 2-space wrap | `• ` notice bullets |
| Slash menu | `/name  desc` two-column | same shape (shared parser) |
| Selection | chromatic vs grey fg | (unverified — shared heuristic) |
| Welcome | block-art logo + text column | box frame → WelcomeCard (`>_` logo) |
| Update notice | changelog column (client-side fetch) | boxed banner → card `notice` column |
| Menu position | above composer | below composer (footer float) |
| Exit banner | `Resume this session with:` | none known (region absence) |

## Sunset note

This layer is the bridge until ACP (Agent Client Protocol) engines land:
ACP sessions emit structured messages/tool-calls/permissions and need no
screen scraping. Keep grammars small and disposable — new investment should
prefer the ACP adapter, and `grammars` should only grow for agents that
lack ACP support.
