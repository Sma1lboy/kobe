/**
 * Claude-specific lifetime usage summation for the cost dashboard.
 *
 * Moved out of `monitor/cost.ts` so the vendor knowledge (claude's
 * per-message `usage` fields inside `~/.claude/projects/*` JSONL) lives
 * beside the rest of the claude transcript code, and the monitor reaches
 * it only through the engine registry's `summarizeCost` entry. The
 * directory-layout knowledge stays in `history.ts`
 * (`listSessionFilesForWorktree`); this module only reads each transcript
 * and SUMS the per-message `usage` fields cumulatively (the dashboard
 * wants lifetime cost, not a last-turn snapshot).
 */

import { readFile } from "node:fs/promises"
import type { EngineCostSummary } from "../registry.ts"
import { listSessionFilesForWorktree } from "./history.ts"

interface JsonlUsageRecord {
  readonly message?: {
    readonly usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/**
 * Sum Claude usage across every session transcript in the worktree.
 * Returns zeros (`sessionCount: 0`) when the task was never entered.
 * Never throws — unreadable files / bad lines are skipped.
 */
export async function summarizeClaudeWorktreeCost(worktree: string): Promise<EngineCostSummary> {
  const files = await listSessionFilesForWorktree(worktree)
  const base: EngineCostSummary = {
    sessionCount: files.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    // files are sorted newest-first by the lister, so file[0]'s mtime
    // is the worktree's most recent activity.
    lastActivityMs: files[0]?.mtimeMs ?? null,
  }
  if (files.length === 0) return base

  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreate = 0
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(file.path, "utf8")
    } catch {
      continue
    }
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue
      let parsed: JsonlUsageRecord
      try {
        parsed = JSON.parse(line) as JsonlUsageRecord
      } catch {
        continue
      }
      const usage = parsed.message?.usage
      if (!usage) continue
      if (typeof usage.input_tokens === "number") input += usage.input_tokens
      if (typeof usage.output_tokens === "number") output += usage.output_tokens
      if (typeof usage.cache_read_input_tokens === "number") cacheRead += usage.cache_read_input_tokens
      if (typeof usage.cache_creation_input_tokens === "number") cacheCreate += usage.cache_creation_input_tokens
    }
  }
  return {
    ...base,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
  }
}
