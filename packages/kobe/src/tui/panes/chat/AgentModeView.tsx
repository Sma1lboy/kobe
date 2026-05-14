import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import type { BackgroundAgent, BackgroundAgentStatus } from "../../../types/engine"
import { type Theme, useTheme } from "../../context/theme"

export function AgentModeView(props: {
  readonly orchestrator: KobeOrchestrator
  readonly taskId: () => string | undefined
}) {
  const { theme } = useTheme()
  const [agents, setAgents] = createSignal<readonly BackgroundAgent[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    const taskId = props.taskId()
    if (!taskId) {
      setAgents([])
      return
    }
    let canceled = false
    setLoading(true)
    setError(null)
    props.orchestrator
      .listBackgroundAgents(taskId)
      .then((next) => {
        if (!canceled) setAgents(next)
      })
      .catch((err: unknown) => {
        if (!canceled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!canceled) setLoading(false)
      })
    onCleanup(() => {
      canceled = true
    })
  })

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <Show when={loading()}>
        <text fg={theme.textMuted}>loading agents...</text>
      </Show>
      <Show when={error()}>{(err) => <text fg={theme.warning}>agent view error: {err()}</text>}</Show>
      <Show when={!loading() && !error() && agents().length === 0}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>No Claude background agents for this worktree.</text>
        </box>
      </Show>
      <Show when={agents().length > 0}>
        <box flexDirection="column" gap={1}>
          <For each={groupedAgents(agents())}>
            {(group) => (
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                    {group.label.toUpperCase()}
                  </text>
                  <text fg={theme.textMuted}>{String(group.items.length)}</text>
                </box>
                <For each={group.items}>{(agent) => <AgentRow agent={agent} />}</For>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function AgentRow(props: { readonly agent: BackgroundAgent }) {
  const { theme } = useTheme()
  const status = () => statusMeta(props.agent.status)
  const title = () => props.agent.name ?? props.agent.sessionId.slice(0, 8)
  const detail = () => {
    const updated = formatAge(props.agent.updatedAtMs ?? props.agent.startedAtMs)
    const raw = props.agent.sourceStatus ? ` · ${props.agent.sourceStatus}` : ""
    return `${props.agent.sessionId.slice(0, 8)} · ${updated}${raw}`
  }
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text fg={status().color(theme)} wrapMode="none">
          {status().marker}
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {title()}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {detail()}
        </text>
      </box>
      <box paddingLeft={2}>
        <text fg={theme.textMuted} wrapMode="none">
          {props.agent.cwd}
        </text>
      </box>
    </box>
  )
}

function groupedAgents(agents: readonly BackgroundAgent[]): Array<{ label: string; items: BackgroundAgent[] }> {
  const groups: Array<{ key: BackgroundAgentStatus; label: string; items: BackgroundAgent[] }> = [
    { key: "running", label: "working", items: [] },
    { key: "blocked", label: "needs input", items: [] },
    { key: "idle", label: "idle", items: [] },
    { key: "completed", label: "completed", items: [] },
    { key: "failed", label: "failed", items: [] },
    { key: "unknown", label: "other", items: [] },
  ]
  const byKey = new Map(groups.map((g) => [g.key, g]))
  for (const agent of agents) (byKey.get(agent.status) ?? byKey.get("unknown"))?.items.push(agent)
  return groups.filter((g) => g.items.length > 0)
}

function statusMeta(status: BackgroundAgentStatus): {
  marker: string
  color: (theme: Theme) => Theme["text"]
} {
  switch (status) {
    case "running":
      return { marker: "●", color: (theme) => theme.success }
    case "blocked":
      return { marker: "●", color: (theme) => theme.warning }
    case "failed":
      return { marker: "!", color: (theme) => theme.warning }
    default:
      return { marker: "·", color: (theme) => theme.textMuted }
  }
}

function formatAge(ms: number | null): string {
  if (!ms) return "unknown"
  const delta = Math.max(0, Date.now() - ms)
  const min = Math.floor(delta / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
