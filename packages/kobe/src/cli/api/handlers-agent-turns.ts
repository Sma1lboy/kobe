/**
 * `agent-turns` — the read end of per-turn agent telemetry (issue #32).
 *
 * The records are produced by each engine's own adapter (the turn's model,
 * timings, and token usage come from that vendor's transcript) and joined to
 * task/tab identity by the daemon at ingest. This verb only reads them back,
 * plus a totals roll-up so a caller doesn't have to sum the page itself.
 */

import type { AgentTurnRecord } from "@sma1lboy/kobe-daemon/daemon/contracts"
import { daemonOf } from "./handler-helpers.ts"
import type { VerbContext, VerbSpec } from "./types.ts"

const DEFAULT_SINCE_DAYS = 7
const DEFAULT_LIMIT = 200

export interface AgentTurnTotals {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  /** Summed wall-clock of the turns in the page, milliseconds. */
  readonly durationMs: number
  /** Turn counts per model, so "which model did the work" needs no second pass. */
  readonly byModel: Record<string, number>
}

/** Roll a page of turns into totals. Pure — the unit-tested half. */
export function summarizeTurns(turns: readonly AgentTurnRecord[]): AgentTurnTotals {
  const byModel: Record<string, number> = {}
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let durationMs = 0
  for (const turn of turns) {
    inputTokens += turn.usage?.input_tokens ?? 0
    outputTokens += turn.usage?.output_tokens ?? 0
    cacheReadTokens += turn.usage?.cache_read_input_tokens ?? 0
    cacheCreationTokens += turn.usage?.cache_creation_input_tokens ?? 0
    durationMs += Math.max(0, turn.endedAt - turn.startedAt)
    const model = turn.model ?? "unknown"
    byModel[model] = (byModel[model] ?? 0) + 1
  }
  return {
    turns: turns.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    durationMs,
    byModel,
  }
}

async function agentTurns(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskId = ctx.args.str("task-id")
  const repoPath = ctx.args.path("repo")
  const repo = repoPath ? await ctx.runtime.resolveRepoRoot(repoPath) : undefined
  const sinceDays = ctx.args.int("since-days") ?? DEFAULT_SINCE_DAYS
  const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000
  const limit = ctx.args.int("limit") ?? DEFAULT_LIMIT
  const { turns } = await daemon.request<{ turns: AgentTurnRecord[] }>("agentTurn.list", {
    ...(taskId ? { taskId } : {}),
    ...(repo ? { repoRoot: repo } : {}),
    since,
    limit,
  })
  return { since: new Date(since).toISOString(), totals: summarizeTurns(turns), turns }
}

export const AGENT_TURNS_VERB: VerbSpec = {
  name: "agent-turns",
  summary:
    "Per-turn agent telemetry: one record per completed engine turn (task/tab/vendor/model/timings/tokens), newest first, plus totals. Engine-produced, daemon-stored; read-only.",
  flags: [
    { name: "task-id", type: "string", placeholder: "ID", description: "Only this task's turns." },
    {
      name: "repo",
      type: "string",
      placeholder: "PATH",
      description: "Only turns of tasks in this repo. Relative paths resolve against $PWD.",
    },
    {
      name: "since-days",
      type: "int",
      default: String(DEFAULT_SINCE_DAYS),
      placeholder: "N",
      description: "Look-back window in days.",
    },
    {
      name: "limit",
      type: "int",
      default: String(DEFAULT_LIMIT),
      placeholder: "N",
      description: "Max turns returned.",
    },
  ],
  handler: agentTurns,
}
