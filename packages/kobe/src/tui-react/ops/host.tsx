/** @jsxImportSource @opentui/react */
/**
 * React `kobe ops` host — the `src/tui/ops/host.tsx` counterpart (issue
 * #15, G3), behind `KOBE_REACT=1` in `cli/commands-tui.ts`. Same pane, same
 * shared framework-free pieces: the poll-loop bodies
 * (`tui/ops/activity-monitor.ts`), the shell actions + concrete IO
 * (`tui/ops/host-io.ts`), and the already-ported React FileTree. This file
 * owns only the React reactivity.
 *
 * CLIENT-LAYER LIVE STATE: React never consumes Solid signals — the
 * daemon's `transcript.activity` push is read through
 * `RemoteOrchestrator.transcriptActivityStore()`, the external-store twin
 * of `transcriptActivitySignal()` (same dual-write precedent as
 * `uiPrefsStore`), via `useSyncExternalStore`. The poll loops read the
 * LATEST map through a render-refreshed ref — they are timer-driven, not
 * reactive, exactly like the Solid host's untracked reads.
 */

import { createEngineTurnDetector } from "@/engine/turn-detector"
import type { VendorId } from "@/types/task"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import type { RemoteOrchestrator, TranscriptActivityMap } from "../../client/remote-orchestrator"
import { startLocalBadgePoll, startTurnStatusPoll } from "../../tui/ops/activity-monitor"
import { badgePollIo, makeOpsActions, turnStatusIo } from "../../tui/ops/host-io"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { FileTree } from "../panes/filetree/FileTree"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
  /** Task engine vendor — selects which transcript store the activity badge polls. */
  readonly vendor: VendorId
}

const noopSubscribe = () => () => {}

export function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()
  const t = useT()
  // Props are process-lifetime launcher args — safe to bind once.
  const actionsRef = useRef(makeOpsActions(props))
  const actions = actionsRef.current

  // ONE scoped pane orchestrator for the daemon's `transcript.activity`
  // channel — non-spawning + leak-guarded (a late connect after unmount is
  // disposed on the spot), same contract as the Solid host and host-boot's
  // UiPrefsSync. No daemon / an old daemon without the channel leaves the
  // map `null`, which is the fallback trigger throughout this component.
  const [activityOrch, setActivityOrch] = useState<RemoteOrchestrator | null>(null)
  useEffect(() => {
    let disposed = false
    let orch: RemoteOrchestrator | null = null
    void (async () => {
      const remote = await connectPaneOrchestrator({ logTag: "ops-activity", channels: ["transcript.activity"] })
      if (!remote) return
      if (disposed) {
        remote.dispose()
        return
      }
      orch = remote
      setActivityOrch(remote)
    })()
    return () => {
      disposed = true
      orch?.dispose()
    }
  }, [])

  // The daemon-collected facts, live via the external-store twin (see file
  // header). `null` until a daemon with the channel pushes data.
  const activityStore = activityOrch?.transcriptActivityStore()
  const sharedActivityMap = useSyncExternalStore(
    useCallback((cb: () => void) => (activityStore ? activityStore.subscribe(cb) : noopSubscribe()), [activityStore]),
    () => activityStore?.get() ?? null,
  )
  // Latest-render mirror for the timer-driven loops (they must always see
  // the current map without being torn down per push).
  const sharedMapRef = useRef<TranscriptActivityMap | null>(sharedActivityMap)
  sharedMapRef.current = sharedActivityMap

  // New-activity badge (KOB-254) — same two-source design as the Solid
  // host: the daemon push when available, the local mtime probe otherwise.
  // `baseline` seeds at the first observed mtime so a pane mounting onto an
  // already-busy task doesn't flash stale activity; `r` refresh acks it.
  const [baseline, setBaseline] = useState(0)
  const [latest, setLatest] = useState(0)
  const primedRef = useRef(false)

  // Shared-source badge: seed the baseline on the first NON-ZERO mtime (an
  // empty/just-connected map reads 0 — not real activity), then track
  // advances. Inert while there's no daemon-collected data.
  useEffect(() => {
    const map = sharedActivityMap
    if (!map) return
    const mtime = map.get(props.worktree)?.mtimeMs ?? 0
    if (!primedRef.current && mtime > 0) {
      primedRef.current = true
      setBaseline(mtime)
    }
    setLatest(mtime)
  }, [sharedActivityMap, props.worktree])

  // Local fallback badge poll — runs ONLY while there's no daemon-collected
  // data; torn down the instant the channel becomes available and restarted
  // if a reconnect downgrades. Loop body shared with the Solid host.
  const sharedAvailable = sharedActivityMap !== null
  useEffect(() => {
    if (sharedAvailable) return
    return startLocalBadgePoll(badgePollIo(props.vendor, props.worktree), {
      isPrimed: () => primedRef.current,
      prime: (mtime) => {
        primedRef.current = true
        setBaseline(mtime)
      },
      setLatest,
    })
  }, [sharedAvailable, props.vendor, props.worktree])

  const hasNewActivity = primedRef.current && latest > baseline
  const cornerBadge = hasNewActivity ? { text: t("ops.badge.newActivity"), active: true } : null
  const ackActivity = useCallback(() => setBaseline(latest), [latest])

  // Per-window turn detector — mounted once for the pane's lifetime (like
  // the Solid host's onMount); the getters read the live map off the ref.
  useEffect(() => {
    const targetPane = props.targetPane
    if (!targetPane) return
    return startTurnStatusPoll(
      {
        worktree: props.worktree,
        detector: createEngineTurnDetector(props.vendor),
        usingShared: () => sharedMapRef.current !== null,
        sharedEntry: () => sharedMapRef.current?.get(props.worktree) ?? null,
      },
      turnStatusIo(targetPane),
    )
  }, [props.targetPane, props.vendor, props.worktree])

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <FileTree
        worktreePath={props.worktree}
        focused={true}
        onOpenFile={actions.openFile}
        onMention={actions.injectMention}
        onCreatePR={() => void actions.createPR()}
        onZenToggle={props.taskId ? actions.toggleZen : undefined}
        cornerBadge={cornerBadge}
        onRefresh={ackActivity}
      />
    </box>
  )
}

export async function startOpsHost(args: OpsHostArgs): Promise<void> {
  // No KV / Focus providers — the FileTree never touches persisted UI
  // state or pane focus; this pane has always been Theme > Dialog only.
  await bootPaneHost({
    logContext: "ops",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <OpsShell {...args} /> }),
  })
}
