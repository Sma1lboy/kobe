import type { ChannelName } from "@sma1lboy/kobe-daemon/daemon/protocol"

/**
 * The ONLY daemon channels the web SPA actually consumes (see the SPA's
 * `applyEvent` + `snapshot` hydration in `src/lib/store.ts`). Everything else
 * the daemon publishes — today just `keybindings` — is dead weight for the
 * web UI: it would get JSON-stringified per client, pushed over SSE,
 * JSON-parsed by the browser, and dropped.
 *
 * Two enforcement points share this list (both in `daemon-link.ts` /
 * `bridge.ts`):
 *  - `subscribe({ channels })` — the daemon honors this per-channel filter
 *    (server.ts `normalizeChannelFilter`), so unconsumed channels stop at the
 *    daemon socket and never cross to the bridge at all.
 *  - the bridge SSE fan-out — belt-and-suspenders for an older daemon that
 *    predates the filter, so the unconsumed channels never reach a browser.
 *
 * Kept as its own leaf module (no daemon-client imports) so the contract test
 * can assert it against the SPA's reducer without pulling in node-only deps.
 */
export const SPA_CHANNELS: readonly ChannelName[] = [
  "task.snapshot",
  "issue.snapshot",
  "active-task",
  "engine-state",
  "update",
  "task.jobs",
  "worktree.changes",
  "task.conflicts",
  "session.deliver",
  "ui-prefs",
]

/** Membership test for the SSE fan-out filter. */
export const SPA_CHANNEL_SET: ReadonlySet<string> = new Set<string>(SPA_CHANNELS)
