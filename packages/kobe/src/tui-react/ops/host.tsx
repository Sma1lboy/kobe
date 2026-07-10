/** @jsxImportSource @opentui/react */
/**
 * React `kobe ops` host — the `src/tui/ops/host.tsx` counterpart (issue
 * #15, G3). React is the default runtime since 2026-07-07 (`uiFramework()`
 * in `src/env.ts`); `KOBE_SOLID=1` is the legacy escape hatch in
 * `cli/commands-tui.ts`. Same pane, same
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
import { startTurnStatusPoll } from "../../tui/ops/activity-monitor"
import { makeOpsActions, turnStatusIo } from "../../tui/ops/host-io"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { FileTree } from "../panes/filetree/FileTree"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
  /** Task engine vendor — selects the engine turn detector. */
  readonly vendor: VendorId
}

const noopSubscribe = () => () => {}

export function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()
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
