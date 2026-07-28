// src/tui-react/lib/use-daemon-notices.ts
/**
 * Bridge the daemon's `notice.event` broadcast (`kobe api notify`) into the
 * host's NotificationsProvider toast queue.
 *
 * The channel is an EVENT channel with last-value replay: a late subscriber
 * receives the most recent notice on connect. Consumers therefore dedupe on
 * `at` (each publish is uniquely stamped) and drop replays older than
 * {@link STALE_NOTICE_MS} so re-attaching a host doesn't re-toast an old
 * message.
 */

import type { NoticeEventPayload, TabOpenPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { useEffect, useRef } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { createStateCell } from "../../lib/external-store"
import type { NotifyInput } from "../../tui/lib/notify-state"
import { requestTabOpen } from "../workspace/terminal-tabs-shared"
import { useAccessor } from "./use-accessor"

/** Replays older than this never toast — they're reconnect echoes, not news. */
const STALE_NOTICE_MS = 10_000

/** Stable empty store so the hook stays unconditional when no daemon is attached. */
const NO_NOTICES = createStateCell<NoticeEventPayload | null>(null)
const NO_TAB_OPENS = createStateCell<TabOpenPayload | null>(null)

/**
 * Bridge `tab.open` broadcasts (plugin panes) into the shared pending
 * tab-open request TerminalTabs consumes. Lives here (not host.tsx) so the
 * host wires ONE daemon-event bridge hook; same `at` dedupe + stale drop
 * as notices.
 */
function useDaemonTabOpens(orch: RemoteOrchestrator | null): void {
  const request = useAccessor(orch ? orch.tabOpenStore() : NO_TAB_OPENS)
  const seenAt = useRef<number | null>(null)
  useEffect(() => {
    if (!request || request.at === seenAt.current) return
    seenAt.current = request.at
    if (Date.now() - request.at > STALE_NOTICE_MS) return
    requestTabOpen(request.taskId, request.argv, request.title)
  }, [request])
}

export function useDaemonNotices(orch: RemoteOrchestrator | null, notify: (input: NotifyInput) => void): void {
  useDaemonTabOpens(orch)
  const notice = useAccessor(orch ? orch.noticeStore() : NO_NOTICES)
  const seenAt = useRef<number | null>(null)
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  useEffect(() => {
    if (!notice || notice.at === seenAt.current) return
    seenAt.current = notice.at
    if (Date.now() - notice.at > STALE_NOTICE_MS) return
    // Arbitrary kinds are allowed on the wire; only the known severities
    // carry styling/unread semantics — everything else renders as "done".
    const kind = notice.kind === "needs_input" || notice.kind === "error" ? notice.kind : "done"
    notifyRef.current({ kind, taskId: notice.taskId ?? "", tabId: "", title: notice.title })
  }, [notice])
}
