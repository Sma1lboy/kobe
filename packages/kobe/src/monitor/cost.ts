/**
 * Per-task cost aggregation for the monitor's cost dashboard (KOB-230).
 *
 * The "where does Claude persist a worktree's session transcripts"
 * knowledge lives in `engine/claude-code-local/history.ts`
 * (`listSessionFilesForWorktree`) — this module only does the
 * monitor-specific part: read each transcript and SUM the per-message
 * `usage` fields cumulatively (the dashboard wants lifetime cost, not
 * the last-turn snapshot `deriveSessionUsageMetrics` returns).
 *
 * Codex transcripts live under a different root (`~/.codex/sessions/`);
 * we'll plumb them through when KOB-232 lands. For now the dashboard
 * is claude-focused.
 */

import { readFile } from "node:fs/promises"
import { listSessionFilesForWorktree } from "../engine/claude-code-local/history.ts"

export interface TaskCostSummary {
  readonly taskId: string
  readonly worktree: string
  readonly sessionCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreateTokens: number
  readonly lastActivityMs: number | null
}

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
 */
export async function summarizeTaskCost(opts: {
  taskId: string
  worktree: string
}): Promise<TaskCostSummary> {
  const files = await listSessionFilesForWorktree(opts.worktree)
  const base: TaskCostSummary = {
    taskId: opts.taskId,
    worktree: opts.worktree,
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
