/**
 * Adapter: maps an opentui-free `Chunk` from `./sgr.ts` to an opentui
 * `TextChunk` ready to drop into a `StyledText`. Lives in its own file
 * so `./sgr.ts` stays opentui-free — that file is loaded by the SGR
 * unit tests under vitest, which chokes on opentui's tree-sitter
 * `.scm` assets if they're pulled in transitively.
 *
 * The only reason this file exists is the test-runner dep boundary;
 * the conversion itself is trivial.
 */

import { RGBA } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import type { Chunk, RGB } from "./sgr"

function toRGBA(rgb: RGB | undefined): RGBA | undefined {
  if (!rgb) return undefined
  return RGBA.fromInts(rgb[0], rgb[1], rgb[2])
}

export function toTextChunk(c: Chunk): TextChunk {
  return {
    __isChunk: true,
    text: c.text,
    ...(c.fg ? { fg: toRGBA(c.fg) } : {}),
    ...(c.bg ? { bg: toRGBA(c.bg) } : {}),
    ...(c.attributes !== undefined ? { attributes: c.attributes } : {}),
  }
}
