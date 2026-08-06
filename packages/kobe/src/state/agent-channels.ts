/**
 * Durable UI binding between two engine-owned chat tabs.
 *
 * A channel deliberately stores no messages or transcript projection: each
 * endpoint is a normal TerminalTabs tab, so the native engine remains the
 * owner of conversation history, resume, and telemetry.
 */

export const AGENT_CHANNELS_KEY = "agentChannels.v1"

export interface AgentChannelEndpoint {
  readonly taskId: string
  readonly tabId: string
}

export interface AgentChannel {
  readonly id: string
  readonly createdAt: string
  readonly endpoints: readonly [AgentChannelEndpoint, AgentChannelEndpoint]
}

function isEndpoint(value: unknown): value is AgentChannelEndpoint {
  if (!value || typeof value !== "object") return false
  const endpoint = value as Record<string, unknown>
  return typeof endpoint.taskId === "string" && endpoint.taskId !== "" && typeof endpoint.tabId === "string"
}

/** Validate the KV boundary and drop malformed records independently. */
export function readAgentChannels(value: unknown): AgentChannel[] {
  if (!Array.isArray(value)) return []
  const channels: AgentChannel[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue
    const record = candidate as Record<string, unknown>
    if (
      typeof record.id !== "string" ||
      record.id === "" ||
      seen.has(record.id) ||
      typeof record.createdAt !== "string" ||
      !Array.isArray(record.endpoints) ||
      record.endpoints.length !== 2 ||
      !isEndpoint(record.endpoints[0]) ||
      !isEndpoint(record.endpoints[1]) ||
      record.endpoints[0].taskId === record.endpoints[1].taskId
    )
      continue
    seen.add(record.id)
    channels.push({
      id: record.id,
      createdAt: record.createdAt,
      endpoints: [record.endpoints[0], record.endpoints[1]],
    })
  }
  return channels
}

export function createAgentChannel(input: {
  id: string
  createdAt: string
  source: AgentChannelEndpoint
  target: AgentChannelEndpoint
}): AgentChannel {
  if (input.source.taskId === input.target.taskId) throw new Error("Agent channel endpoints must belong to two tasks")
  return {
    id: input.id,
    createdAt: input.createdAt,
    endpoints: [input.source, input.target],
  }
}

/** Only channels whose two task owners still exist can be opened. */
export function availableAgentChannels(
  channels: readonly AgentChannel[],
  taskIds: ReadonlySet<string>,
): AgentChannel[] {
  return channels.filter((channel) => channel.endpoints.every((endpoint) => taskIds.has(endpoint.taskId)))
}
