/**
 * Daemon event bus.
 *
 * One typed pub/sub hub the daemon uses to fan channel events out to
 * subscribed clients. It replaces the inline single-purpose `task.snapshot`
 * broadcast so adding a new push channel is a registry edit + a
 * `publish(channel, payload)` — see {@link ../daemon/protocol.ts ChannelPayloads}.
 *
 * Two jobs:
 *   - **fan-out**: `publish` notifies every registered sink (the server
 *     wires ONE sink that writes the event frame to subscribed sockets).
 *   - **last-value-per-channel**: the most recent payload of each channel
 *     is cached so a client that connects/subscribes LATE gets the current
 *     value immediately (`snapshot()`), the same way `hello` returns the
 *     task list on connect. Suits state channels; a true event-log channel
 *     would only replay its last item (call that out at definition time).
 *
 * Synchronous + dependency-free. A `daemon.stopping` lifecycle signal is
 * intentionally NOT a channel and never flows through here.
 */

import type { ChannelName, ChannelPayloads } from "./protocol.ts"

export interface ChannelEvent<C extends ChannelName = ChannelName> {
  readonly channel: C
  readonly payload: ChannelPayloads[C]
}

export class DaemonEventBus {
  private readonly last = new Map<ChannelName, unknown>()
  private readonly sinks = new Set<(event: ChannelEvent) => void>()

  /** Publish a channel's latest payload: cache it + fan out to all sinks. */
  publish<C extends ChannelName>(channel: C, payload: ChannelPayloads[C]): void {
    this.last.set(channel, payload)
    const event = { channel, payload } as ChannelEvent
    for (const sink of this.sinks) sink(event)
  }

  /** Current value of every populated channel — the late-subscriber replay set. */
  snapshot(): ChannelEvent[] {
    return [...this.last].map(([channel, payload]) => ({ channel, payload }) as ChannelEvent)
  }

  /** Register a fan-out sink; returns an unsubscribe. */
  onPublish(sink: (event: ChannelEvent) => void): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }
}
