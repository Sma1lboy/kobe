/** @jsxImportSource @opentui/react */

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
  readonly targetPane: string | null
  readonly vendor: VendorId
}

const noopSubscribe = () => () => {}

export function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()
  const t = useT()
  const actionsRef = useRef(makeOpsActions(props))
  const actions = actionsRef.current

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

  const activityStore = activityOrch?.transcriptActivityStore()
  const sharedActivityMap = useSyncExternalStore(
    useCallback((cb: () => void) => (activityStore ? activityStore.subscribe(cb) : noopSubscribe()), [activityStore]),
    () => activityStore?.get() ?? null,
  )
  const sharedMapRef = useRef<TranscriptActivityMap | null>(sharedActivityMap)
  sharedMapRef.current = sharedActivityMap

  const [baseline, setBaseline] = useState(0)
  const [latest, setLatest] = useState(0)
  const primedRef = useRef(false)

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
  await bootPaneHost({
    logContext: "ops",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <OpsShell {...args} /> }),
  })
}
