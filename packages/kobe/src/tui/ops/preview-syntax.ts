import { SyntaxStyle } from "@opentui/core"
import type { Theme } from "../context/theme-core"

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
