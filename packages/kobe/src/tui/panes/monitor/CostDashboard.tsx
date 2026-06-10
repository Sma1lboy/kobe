/**
 * Cost dashboard (v0.6 / KOB-230).
 *
 * Reads each task's worktree-scoped Claude transcript JSONL, sums
 * per-message `usage` fields, and renders one row per task. The agent-deck
 * `internal/ui/cost_dashboard.go` layout is the reference: a wide
 * table with right-aligned token columns and a footer total.
 *
 * Sorting: lastActivity desc, so the row a user just left lands at
 * the top. Empty (never-entered) tasks sink to the bottom.
 */

import { For, type JSXElement, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { type TaskCostSummary, summarizeTaskCost } from "../../../monitor/cost.ts"
import type { Task } from "../../../types/task.ts"
import { useTheme } from "../../context/theme"

const REFRESH_MS = 5000

export interface CostDashboardProps {
  tasks: () => readonly Task[]
}

export function CostDashboard(props: CostDashboardProps): JSXElement {
  const { theme } = useTheme()
  const [summaries, setSummaries] = createSignal<readonly TaskCostSummary[]>([])

  const refresh = async (): Promise<void> => {
    const tasks = props.tasks()
    const out = await Promise.all(
      tasks.filter((t) => !!t.worktreePath).map((t) => summarizeTaskCost({ taskId: t.id, worktree: t.worktreePath })),
    )
    out.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0))
    setSummaries(out)
  }

  // In-flight dedupe: summarizing every task's transcript JSONL can outlast
  // the 5s cadence on long histories — drop ticks that land mid-run instead
  // of stacking `Promise.all` sweeps. A rejected sweep keeps the last table
  // instead of surfacing as an unhandled rejection.
  //
  // `lib/background-poll.ts` doesn't fit this view: the poller is keyed per
  // path, while this table is one whole-task-list aggregate (the "key"
  // would have to be the concatenation of all task ids). See
  // docs/design/app-retirement.md — this pane retires with the outer
  // monitor, so the lighter fix wins.
  let inFlight = false
  const tick = (): void => {
    if (inFlight) return
    inFlight = true
    refresh()
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  onMount(() => {
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  const totals = createMemo(() => {
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheCreate = 0
    for (const s of summaries()) {
      input += s.inputTokens
      output += s.outputTokens
      cacheRead += s.cacheReadTokens
      cacheCreate += s.cacheCreateTokens
    }
    return { input, output, cacheRead, cacheCreate }
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.accent}>COST DASHBOARD</text>
        <text fg={theme.textMuted}>(every 5s · press d to close)</text>
      </box>
      <box flexDirection="row" paddingTop={1} gap={2}>
        <text fg={theme.textMuted}>{column("task", 24)}</text>
        <text fg={theme.textMuted}>{column("in", 10)}</text>
        <text fg={theme.textMuted}>{column("out", 10)}</text>
        <text fg={theme.textMuted}>{column("cache r", 10)}</text>
        <text fg={theme.textMuted}>{column("cache c", 10)}</text>
        <text fg={theme.textMuted}>{column("last", 12)}</text>
      </box>
      <For each={summaries()}>
        {(row) => (
          <box flexDirection="row" gap={2}>
            <text fg={theme.text}>{column(taskLabel(row, props.tasks()), 24)}</text>
            <text fg={theme.text}>{column(formatTokens(row.inputTokens), 10)}</text>
            <text fg={theme.text}>{column(formatTokens(row.outputTokens), 10)}</text>
            <text fg={theme.text}>{column(formatTokens(row.cacheReadTokens), 10)}</text>
            <text fg={theme.text}>{column(formatTokens(row.cacheCreateTokens), 10)}</text>
            <text fg={theme.textMuted}>{column(formatLastActivity(row.lastActivityMs), 12)}</text>
          </box>
        )}
      </For>
      <box flexDirection="row" gap={2} paddingTop={1}>
        <text fg={theme.accent}>{column("TOTAL", 24)}</text>
        <text fg={theme.accent}>{column(formatTokens(totals().input), 10)}</text>
        <text fg={theme.accent}>{column(formatTokens(totals().output), 10)}</text>
        <text fg={theme.accent}>{column(formatTokens(totals().cacheRead), 10)}</text>
        <text fg={theme.accent}>{column(formatTokens(totals().cacheCreate), 10)}</text>
        <text fg={theme.textMuted}>{column("", 12)}</text>
      </box>
    </box>
  )
}

function column(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return s + " ".repeat(width - s.length)
}

function formatTokens(n: number): string {
  if (n === 0) return "—"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatLastActivity(ms: number | null): string {
  if (ms === null) return "—"
  const elapsed = Date.now() - ms
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function taskLabel(row: TaskCostSummary, tasks: readonly Task[]): string {
  const task = tasks.find((t) => t.id === row.taskId)
  return task?.title ?? row.taskId.slice(0, 12)
}
