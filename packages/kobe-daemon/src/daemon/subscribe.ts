/**
 * The `subscribe` request — the ONE request that is not a registry handler.
 *
 * It is connection lifecycle, not RPC: it mutates per-socket state
 * (`subscribed`, `holdsLifetime`, `channels`), drives the gui-refcount
 * idle-grace timer, and writes event frames out-of-band during channel replay.
 * None of that fits the registry's payload→result shape, so it lives here
 * beside its own machinery instead (extracted from `server.ts` for the
 * file-size cap; behavior is unchanged).
 */

import type { DaemonActivityRegistry } from "./activity-registry.ts"
import { type ChannelName, normalizeChannelFilter } from "./channels.ts"
import { logDaemonInfo } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { DaemonLifetime } from "./lifetime.ts"
import type { DaemonEventName } from "./protocol.ts"

/** The per-connection state `subscribe` mutates. */
export interface SubscribingClient {
  readonly id: number
  subscribed: boolean
  holdsLifetime: boolean
  channels: ReadonlySet<ChannelName> | null
}

export interface SubscribeDeps {
  readonly bus: DaemonEventBus
  readonly activity: DaemonActivityRegistry
  readonly lifetime: DaemonLifetime
  readonly clientCount: () => number
  readonly writeEvent: (client: SubscribingClient, name: DaemonEventName, payload: unknown) => void
}

/** Handle one `subscribe`. Returns the (empty) response payload. */
export function handleSubscribe(
  client: SubscribingClient,
  payload: Record<string, unknown>,
  deps: SubscribeDeps,
): Record<string, never> {
  const wasSubscribed = client.subscribed
  client.subscribed = true
  // role defaults to "pane": a subscriber that omits it is the safe
  // non-lifetime kind, so a future client can't accidentally pin the
  // daemon open. Only a "gui" attach holds the daemon alive.
  const role = payload.role === "gui" ? "gui" : "pane"
  client.holdsLifetime = role === "gui"
  // Per-channel filter (KOB — per-channel subscribe). `null` = no filter
  // → every channel (back-compat: an omitted/garbage `channels` behaves
  // exactly as before). A non-null set restricts both this replay and
  // every later `broadcast` to the named channels, so a narrow consumer
  // (UiPrefsSync wants only ui-prefs + keybindings) stops receiving —
  // and deserializing — the full task.snapshot fan-out it never reads.
  client.channels = normalizeChannelFilter(payload.channels)
  // First-time subscribe with zero prior subscribers → a collector that
  // had paused (gui-less daemon) repopulates on its NEXT tick; nothing
  // to kick synchronously since the interval keeps running.
  const firstSubscriber = !wasSubscribed
  // A GUI (re)attached → cancel any pending lazy-shutdown grace. A
  // pane subscribing must NOT cancel it: panes alone never keep the
  // daemon up, so a pane connecting during the grace window leaves the
  // countdown running.
  if (client.holdsLifetime) deps.lifetime.guiAttached()
  logDaemonInfo(
    "conn",
    `client #${client.id} subscribed as ${role}${client.channels ? ` [${[...client.channels].join(",")}]` : ""} — ${deps.clientCount()} client(s), ${deps.lifetime.guiCount()} gui${firstSubscriber ? " (collectors resume)" : ""}`,
  )
  // Replay the current value of every populated channel so a late
  // subscriber hydrates without a separate round trip — generalized
  // from the old single task.snapshot send. Filtered to the
  // client's requested channels (null = all). The bus cache is warm
  // (subscribeTasks' eager fire).
  for (const event of deps.bus.snapshot()) {
    if (client.channels && !client.channels.has(event.channel)) continue
    deps.writeEvent(client, event.channel as DaemonEventName, event.payload)
  }
  // The bus only caches ONE last-value per channel, but `engine-state`
  // is per-task — so additionally replay EVERY task's current non-idle
  // activity to this late subscriber (otherwise it'd only learn the most
  // recently changed task's state). Skip when the client filtered
  // `engine-state` out.
  if (!client.channels || client.channels.has("engine-state")) {
    for (const payload of deps.activity.currentNonIdle()) {
      deps.writeEvent(client, "engine-state", payload)
    }
  }
  return {}
}
