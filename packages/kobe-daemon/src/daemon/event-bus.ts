import type { ChannelName, ChannelPayloads } from "./protocol.ts"

export interface ChannelEvent<C extends ChannelName = ChannelName> {
  readonly channel: C
  readonly payload: ChannelPayloads[C]
}

export class DaemonEventBus {
  private readonly last = new Map<ChannelName, unknown>()
  private readonly sinks = new Set<(event: ChannelEvent) => void>()

  publish<C extends ChannelName>(channel: C, payload: ChannelPayloads[C]): void {
    this.last.set(channel, payload)
    const event = { channel, payload } as ChannelEvent
    for (const sink of this.sinks) sink(event)
  }

  snapshot(): ChannelEvent[] {
    return [...this.last].map(([channel, payload]) => ({ channel, payload }) as ChannelEvent)
  }

  onPublish(sink: (event: ChannelEvent) => void): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }
}
