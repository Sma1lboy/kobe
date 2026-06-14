import type { ContentBlock } from "@/types/engine"

/**
 * Synthetic / injected transcript records that Claude Code itself excludes from
 * the human-turn view (its `isHumanTurn` predicate + first-prompt/title paths
 * all skip these). kobe must skip them too — otherwise a session whose first
 * action is a slash command (`/clear`, `/model`, `!cmd`) auto-titles the task
 * from the injected local-command caveat or the `<command-name>` breadcrumb
 * Claude writes BEFORE the real prompt, instead of from the user's prompt.
 *
 * Conservative, mirroring the Codex synthetic filter: only clearly-injected
 * rows are dropped. Tool-result user rows are intentionally NOT filtered here
 * so the transcript view is unchanged.
 */

/**
 * True when the OUTER transcript record is a Claude-injected meta row. The
 * `isMeta` / `isCompactSummary` flags live on the record (not `record.message`)
 * and survive to disk; `isMeta` covers the local-command caveat and most
 * injected envelopes, `isCompactSummary` the post-compaction summary.
 */
export function isSyntheticClaudeRecord(record: Record<string, unknown>): boolean {
  return record.isMeta === true || record.isCompactSummary === true
}

/**
 * True when a `user` record's text is ONLY a slash-command breadcrumb — the
 * `<command-name>…</command-name>` envelope Claude persists as a plain
 * (un-flagged) user record when a slash/bash command runs. Conservative: any
 * real prose mixed in preserves the row.
 */
export function isClaudeCommandBreadcrumb(blocks: readonly ContentBlock[]): boolean {
  if (blocks.length === 0) return false
  for (const b of blocks) {
    if (b.type !== "text") return false
    const t = b.text.trim()
    if (!t.startsWith("<command-name>") && !t.startsWith("<command-message>") && !t.startsWith("<local-command")) {
      return false
    }
  }
  return true
}
