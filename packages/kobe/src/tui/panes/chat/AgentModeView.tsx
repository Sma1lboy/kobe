import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import type { BackgroundAgent, BackgroundAgentStatus } from "../../../types/engine"
import type { VendorId } from "../../../types/task"
import { useFocus } from "../../context/focus"
import { type Theme, useTheme } from "../../context/theme"
import { composerKeyBindings } from "./composer/keybindings"

export function AgentModeView(props: {
  readonly orchestrator: KobeOrchestrator
  readonly taskId: () => string | undefined
  readonly vendor: () => VendorId
  readonly focused?: () => boolean
  readonly onOpenAgent?: () => void
}) {
  const { theme } = useTheme()
  const focusCtx = useFocus()
  const [agents, setAgents] = createSignal<readonly BackgroundAgent[]>([])
  const [draft, setDraft] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [starting, setStarting] = createSignal(false)
  const [openingSessionId, setOpeningSessionId] = createSignal<string | null>(null)
  const [refreshTick, setRefreshTick] = createSignal(0)
  let textareaRef: TextareaRenderable | undefined

  createEffect(() => {
    const taskId = props.taskId()
    refreshTick()
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

  createEffect(() => {
    focusCtx.refocusTick()
    const ref = textareaRef
    if (!ref) return
    if (props.focused?.()) ref.focus()
    else ref.blur()
  })

  async function submitPrompt(): Promise<void> {
    const taskId = props.taskId()
    const ref = textareaRef
    const prompt = (ref?.plainText ?? draft()).trim()
    if (!taskId || !prompt || starting()) return
    setStarting(true)
    setError(null)
    try {
      const agent = await props.orchestrator.startBackgroundAgent(taskId, prompt)
      if (agent) setAgents((cur) => [agent, ...cur.filter((existing) => existing.id !== agent.id)])
      ref?.setText("")
      setDraft("")
      setRefreshTick((n) => n + 1)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  async function openAgent(agent: BackgroundAgent): Promise<void> {
    const taskId = props.taskId()
    if (!taskId || openingSessionId()) return
    setOpeningSessionId(agent.sessionId)
    setError(null)
    try {
      await props.orchestrator.openSessionInTab(taskId, agent.sessionId, {
        title: agent.name ?? `bg ${agent.sessionId.slice(0, 8)}`,
        vendor: props.vendor(),
        source: "background_agent",
      })
      focusCtx.setFocused("workspace")
      props.onOpenAgent?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpeningSessionId(null)
    }
  }

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexGrow={1} flexDirection="column">
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
                  <For each={group.items}>
                    {(agent) => (
                      <AgentRow
                        agent={agent}
                        opening={() => openingSessionId() === agent.sessionId}
                        onOpen={() => void openAgent(agent)}
                      />
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
      <box
        flexShrink={0}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
      >
        <box flexDirection="row" gap={1} alignItems="flex-start">
          <text fg={starting() ? theme.textMuted : theme.primary} attributes={TextAttributes.BOLD}>
            {starting() ? "..." : ">"}
          </text>
          <box flexGrow={1} minHeight={2} maxHeight={4}>
            <textarea
              ref={(r: TextareaRenderable) => {
                textareaRef = r
                if (draft()) r.setText(draft())
                if (props.focused?.()) r.focus()
              }}
              placeholder={starting() ? "Starting background agent..." : "Start a background agent"}
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              backgroundColor={theme.backgroundElement}
              focusedBackgroundColor={theme.backgroundElement}
              wrapMode="word"
              keyBindings={composerKeyBindings}
              onContentChange={setDraft}
              onSubmit={() => void submitPrompt()}
            />
          </box>
        </box>
      </box>
    </box>
  )
}

function AgentRow(props: {
  readonly agent: BackgroundAgent
  readonly opening: () => boolean
  readonly onOpen: () => void
}) {
  const { theme } = useTheme()
  const status = () => statusMeta(props.agent.status)
  const title = () => props.agent.name ?? props.agent.sessionId.slice(0, 8)
  const activity = () => formatAgentActivity(props.agent)
  const age = () => formatAge(props.agent.updatedAtMs ?? props.agent.startedAtMs)
  return (
    <box
      flexDirection="row"
      gap={1}
      minHeight={2}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.opening() ? theme.backgroundElement : undefined}
      onMouseUp={props.onOpen}
    >
      <text fg={status().color(theme)} wrapMode="none">
        {status().marker}
      </text>
      <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
        {title()}
      </text>
      <box flexGrow={1}>
        <Show when={activity()}>
          {(label) => (
            <text fg={theme.textMuted} wrapMode="none">
              {label()}
            </text>
          )}
        </Show>
      </box>
      <Show when={props.opening()}>
        <text fg={theme.textMuted} wrapMode="none">
          opening...
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="none">
        {age()}
      </text>
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
    { key: "stopped", label: "stopped", items: [] },
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
    case "completed":
      return { marker: "✓", color: (theme) => theme.success }
    case "failed":
      return { marker: "!", color: (theme) => theme.error }
    case "stopped":
      return { marker: "■", color: (theme) => theme.textMuted }
    default:
      return { marker: "·", color: (theme) => theme.textMuted }
  }
}

function formatAgentActivity(agent: BackgroundAgent): string | null {
  const source = humanizeSourceStatus(agent.sourceStatus)
  if (!source || isGenericStatusLabel(source)) return null
  return source
}

const GENERIC_STATUS_LABELS = new Set([
  "running",
  "working",
  "active",
  "in progress",
  "busy",
  "blocked",
  "needs input",
  "awaiting input",
  "waiting for input",
  "idle",
  "done",
  "complete",
  "completed",
  "success",
  "succeeded",
  "error",
  "failed",
  "crashed",
  "stopped",
  "stop",
  "cancelled",
  "canceled",
  "interrupted",
  "aborted",
  "killed",
])

function isGenericStatusLabel(label: string): boolean {
  return GENERIC_STATUS_LABELS.has(label)
}

function humanizeSourceStatus(status: string | null | undefined): string | null {
  if (!status) return null
  const normalized = status.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
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
