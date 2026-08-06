/**
 * Engine screen grammar — the per-vendor contract behind the /chat translated
 * render. A grammar answers three questions about a live PTY viewport:
 * where is the composer (input region), how do lines become display blocks,
 * and which banner means "the engine exited". Vendors register here; an
 * unknown vendor gets the RAW grammar (never finds a region), which the shell
 * renders as a plain terminal — translation is progressive enhancement, not
 * a requirement. Porting guide: docs/design/engine-screen-grammar.md.
 */

import {
  type ClaudeInputRegion,
  findClaudeInputRegion,
} from "./claude-input.ts"
import { parseTtyBlocks, type TtyBlock } from "./claude-tty.ts"
import { findCodexInputRegion, parseCodexBlocks } from "./codex-tty.ts"
import type { ColoredLine } from "./tty-color.ts"

export type InputRegion = ClaudeInputRegion

export interface EngineGrammar {
  /** Locate the engine's composer in the viewport; null = raw terminal. */
  findInputRegion(lines: readonly string[]): InputRegion | null
  /** Translate body lines into display blocks (bubbles, menus, cards…). */
  parseBlocks(lines: readonly ColoredLine[]): TtyBlock[]
  /** Session-over banner. Position matters: below the input box = stale box;
   *  above it = the engine was relaunched. null = rely on region absence. */
  exitBanner: RegExp | null
  /** Right-aligned status chip (Claude's `· /effort`) lifted next to the
   *  composer; null = no chip. */
  effortLine: RegExp | null
}

export const claudeGrammar: EngineGrammar = {
  findInputRegion: findClaudeInputRegion,
  parseBlocks: parseTtyBlocks,
  exitBanner: /^Resume this session with:|^claude --resume\s/,
  effortLine: /·\s*\/effort$/,
}

/** Codex CLI (sampled v0.146): `› ` composer with a `model · dir` status line
 *  under it, a below-composer slash menu (needs the wider tail window), and a
 *  box-framed welcome banner folded into the welcome card. No known exit
 *  banner yet — region absence is the signal. */
export const codexGrammar: EngineGrammar = {
  findInputRegion: findCodexInputRegion,
  parseBlocks: parseCodexBlocks,
  exitBanner: null,
  effortLine: null,
}

/** Unknown engines: never claim a region → the shell stays a raw terminal. */
export const rawGrammar: EngineGrammar = {
  findInputRegion: () => null,
  parseBlocks: parseTtyBlocks,
  exitBanner: null,
  effortLine: null,
}

const GRAMMARS: Record<string, EngineGrammar> = {
  claude: claudeGrammar,
  codex: codexGrammar,
}

/** Vendor → grammar. No vendor = kobe's default engine (claude). */
export function grammarFor(vendor: string | undefined): EngineGrammar {
  if (!vendor) return claudeGrammar
  return GRAMMARS[vendor] ?? rawGrammar
}
