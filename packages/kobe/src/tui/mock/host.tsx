/**
 * `dev:mock` host — render a REAL kobe pane against FAKE data.
 *
 * `bun run dev:mock` boots a real pane component (the live history preview) with
 * a synthetic, growing transcript — no engine, tmux, daemon, worktree, or
 * `~/.kobe` involved. It's for eyeballing UI + interaction fast (theme, layout,
 * CJK, long lines, the live tail) without the dev:sandbox round-trip.
 *
 * How it works: the pane hosts take their transcript through an injectable
 * `EngineHistoryReader` (see history/host.tsx). Here we pass a fake reader whose
 * message list grows on a timer + advances its mtime, so the pane's own mtime
 * poll refetches and you watch the transcript tail live.
 *
 * To mock another pane, add a branch to `startMockHost` (each pane host already
 * takes its data via a narrow seam — inject a fake the same way).
 */

import { coerceVendorId } from "@/types/vendor"
import { startHistoryHost } from "../history/host"
import { MOCK_HISTORY_WORKTREE, createMockHistoryReader } from "../history/mock-fixtures"

export async function startMockHost(): Promise<void> {
  await startHistoryHost({
    worktree: MOCK_HISTORY_WORKTREE,
    vendor: coerceVendorId("claude"),
    live: true,
    reader: createMockHistoryReader(),
  })
}

void startMockHost()
