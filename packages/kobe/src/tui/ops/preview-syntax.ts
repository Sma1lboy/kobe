/**
 * Theme → tree-sitter SyntaxStyle mapping for the ops preview window,
 * extracted from `tui/ops/host.tsx` and shared by the Solid and React
 * previews (issue #15, G3). Kept apart from `./preview-core` because it
 * imports `@opentui/core`, which vitest can't load.
 */

import { SyntaxStyle } from "@opentui/core"
import type { Theme } from "../context/theme-core"

/**
 * Build a tree-sitter SyntaxStyle from the active kobe theme.
 * `SyntaxStyle.create()` is an EMPTY style — opentui parses the code
 * into capture groups but renders them plain unless each scope has a
 * registered colour. We map the nvim-treesitter capture names the
 * bundled ts/js/markdown grammars emit (probed: keyword, string,
 * comment, type, function, number, …) onto kobe's palette so the
 * preview's highlighting matches the rest of the TUI.
 */
export function buildSyntaxStyle(theme: Theme): SyntaxStyle {
  const kw = { fg: theme.primary }
  const str = { fg: theme.success }
  const fn = { fg: theme.info }
  const typ = { fg: theme.warning }
  const num = { fg: theme.accent }
  const com = { fg: theme.textMuted, italic: true }
  const punct = { fg: theme.textMuted }
  const txt = { fg: theme.text }
  return SyntaxStyle.fromStyles({
    keyword: kw,
    "keyword.function": kw,
    "keyword.return": kw,
    "keyword.import": kw,
    "keyword.exception": kw,
    "keyword.conditional": kw,
    "keyword.repeat": kw,
    "keyword.operator": kw,
    "keyword.modifier": kw,
    "keyword.type": kw,
    string: str,
    "string.escape": str,
    "string.regexp": str,
    "string.special": str,
    "character.special": str,
    comment: com,
    "comment.documentation": com,
    function: fn,
    "function.call": fn,
    "function.method": fn,
    "function.builtin": fn,
    constructor: fn,
    type: typ,
    "type.builtin": typ,
    constant: num,
    "constant.builtin": num,
    boolean: num,
    number: num,
    operator: punct,
    "punctuation.bracket": punct,
    "punctuation.delimiter": punct,
    "punctuation.special": punct,
    variable: txt,
    "variable.member": txt,
    "variable.parameter": txt,
    "variable.builtin": num,
    property: txt,
    attribute: typ,
    label: txt,
    module: txt,
  })
}
