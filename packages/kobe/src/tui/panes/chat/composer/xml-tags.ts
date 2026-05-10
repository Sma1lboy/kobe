/**
 * XML tag constants + `extractTag` parser — lifted verbatim from
 * `refs/claude-code/src/constants/xml.ts` and
 * `refs/claude-code/src/utils/messages.ts` so kobe's user-message
 * renderer parses claude-code's command/output wrappers exactly the
 * way claude-code does.
 *
 * Don't fork the parser. When refs/ updates, re-sync this file from
 * the canonical source rather than hand-editing the regex — claude-code
 * tunes it for nested-tag depth handling that the surface-level regex
 * doesn't cover.
 */

// --- constants (refs/claude-code/src/constants/xml.ts) ----------------

export const COMMAND_NAME_TAG = "command-name"
export const COMMAND_MESSAGE_TAG = "command-message"
export const COMMAND_ARGS_TAG = "command-args"

export const BASH_INPUT_TAG = "bash-input"
export const BASH_STDOUT_TAG = "bash-stdout"
export const BASH_STDERR_TAG = "bash-stderr"
export const LOCAL_COMMAND_STDOUT_TAG = "local-command-stdout"
export const LOCAL_COMMAND_STDERR_TAG = "local-command-stderr"
export const LOCAL_COMMAND_CAVEAT_TAG = "local-command-caveat"

// --- extractTag (refs/claude-code/src/utils/messages.ts:633) ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Extract the inner text of `<tagName>…</tagName>` from a string.
 *
 * Handles:
 *   1. Self-closing tags
 *   2. Tags with attributes
 *   3. Nested tags of the same type (returns the outermost match)
 *   4. Multiline content
 *
 * Returns `null` when the tag is absent or empty.
 */
export function extractTag(html: string, tagName: string): string | null {
  if (!html.trim() || !tagName.trim()) return null

  const escapedTag = escapeRegExp(tagName)
  // Opening tag (with optional attributes) + non-greedy content + closing tag.
  const pattern = new RegExp(`<${escapedTag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, "gi")

  let match: RegExpExecArray | null = null
  let lastIndex = 0
  const openingTag = new RegExp(`<${escapedTag}(?:\\s+[^>]*?)?>`, "gi")
  const closingTag = new RegExp(`<\\/${escapedTag}>`, "gi")

  match = pattern.exec(html)
  while (match !== null) {
    const content = match[1]
    const beforeMatch = html.slice(lastIndex, match.index)

    let depth = 0
    openingTag.lastIndex = 0
    while (openingTag.exec(beforeMatch) !== null) depth++
    closingTag.lastIndex = 0
    while (closingTag.exec(beforeMatch) !== null) depth--

    if (depth === 0 && content) return content

    lastIndex = match.index + match[0].length
    match = pattern.exec(html)
  }
  return null
}
