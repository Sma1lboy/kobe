import type { ChannelName } from "@sma1lboy/kobe-daemon/daemon/protocol"

/**
 * The ONLY daemon channels the web SPA actually consumes (see the SPA's
 * `applyEvent` + `snapshot` hydration in `src/lib/store.ts`). Everything else
 * the daemon publishes — `worktree.changes` (the full path→counts map,
 * republished on every count change while agents write), `ui-prefs`,
 * `keybindings`, `task.jobs` — is dead weight for the web UI: it would get
 * JSON-stringified per client, pushed over SSE, JSON-parsed by the browser,
 * and dropped.
 *
 * Two enforcement points share this list (both in `daemon-link.ts` /
 * `bridge.ts`):
 *  - `subscribe({ channels })` — forward-compat for the daemon-side per-channel
 *    filter (accepted-but-ignored today; harmless now, stops the bytes at the
 *    socket once the daemon honors it).
 *  - the bridge SSE fan-out — the effective filter today, so the unconsumed
 *    channels never reach a browser.
 *
 * Kept as its own leaf module (no daemon-client imports) so the contract test
 * can assert it against the SPA's reducer without pulling in node-only deps.
 */
export const SPA_CHANNELS: readonly ChannelName[] = [
  "task.snapshot",
  "active-task",
  "engine-state",
  "update",
]

/** Membership test for the SSE fan-out filter. */
export const SPA_CHANNEL_SET: ReadonlySet<string> = new Set<string>(SPA_CHANNELS)
