/**
 * Per-task cost aggregation for the monitor's cost dashboard (KOB-230).
 *
 * Source of truth is Claude Code's on-disk JSONL transcript:
 *
 *     ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * where `<encoded-cwd>` is the worktree's absolute path with `/`
 * replaced by `-`. We list every JSONL in the encoded directory for a
 * given worktree, read each one, sum the per-message `usage` fields,
 * and surface a single {@link TaskCostSummary} that the dashboard
 * tile renders.
 *
 * Codex transcripts live under a different root (`~/.codex/sessions/`)
 * with a different layout; we'll plumb them through here when KOB-232
 * lands the create-PR companion. For now the dashboard is
 * claude-focused.
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { encodeCwd } from "../engine/claude-code-local/history.ts"

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
  readonly timestamp?: string
}

/**
 * Aggregate Claude usage across every session JSONL in the given
 * worktree. Returns zeros (with `sessionCount: 0`) when the directory
 * doesn't exist yet — i.e. the task was created but never ⏎'d into.
 */
export async function summarizeTaskCost(opts: {
  taskId: string
  worktree: string
}): Promise<TaskCostSummary> {
  const empty: TaskCostSummary = {
    taskId: opts.taskId,
    worktree: opts.worktree,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    lastActivityMs: null,
  }
  if (!opts.worktree) return empty
  const projectsDir = path.join(homedir(), ".claude", "projects", encodeCwd(opts.worktree))
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch {
    return empty
  }
  const jsonl = entries.filter((e) => e.endsWith(".jsonl"))
  if (jsonl.length === 0) return empty
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreate = 0
  let lastActivity = 0
  for (const file of jsonl) {
    const full = path.join(projectsDir, file)
    let raw: string
    try {
      raw = await readFile(full, "utf8")
    } catch {
      continue
    }
    try {
      const st = await stat(full)
      if (st.mtimeMs > lastActivity) lastActivity = st.mtimeMs
    } catch {
      // best-effort — keep going with whatever lastActivity we had
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
    taskId: opts.taskId,
    worktree: opts.worktree,
    sessionCount: jsonl.length,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    lastActivityMs: lastActivity > 0 ? lastActivity : null,
  }
}
