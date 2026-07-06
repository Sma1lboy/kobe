import { createEngineTurnDetector } from "@/engine/turn-detector"
import type { VendorId } from "@/types/task"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import type { RemoteOrchestrator, TranscriptActivity } from "../../client/remote-orchestrator"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { FileTree } from "../panes/filetree/FileTree"
import { startLocalBadgePoll, startTurnStatusPoll } from "./activity-monitor"
import { badgePollIo, makeOpsActions, turnStatusIo } from "./host-io"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  readonly targetPane: string | null
  readonly vendor: VendorId
}

function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()
  const actions = makeOpsActions(props)

  const [activityOrch, setActivityOrch] = createSignal<RemoteOrchestrator | null>(null)
  let orchDisposed = false
  onMount(() => {
    void (async () => {
      const remote = await connectPaneOrchestrator({ logTag: "ops-activity", channels: ["transcript.activity"] })
      if (!remote) return
      if (orchDisposed) {
        remote.dispose()
        return
      }
      setActivityOrch(remote)
    })()
  })
  onCleanup(() => {
    orchDisposed = true
    activityOrch()?.dispose()
  })
  const sharedActivityMap = () => activityOrch()?.transcriptActivitySignal()() ?? null
  const sharedEntry = (): TranscriptActivity | null => sharedActivityMap()?.get(props.worktree) ?? null

  const [baseline, setBaseline] = createSignal(0)
  const [latest, setLatest] = createSignal(0)
  let primed = false

  createEffect(() => {
    const map = sharedActivityMap()
    if (!map) return
    const mtime = map.get(props.worktree)?.mtimeMs ?? 0
    if (!primed && mtime > 0) {
      primed = true
      setBaseline(mtime)
    }
    setLatest(mtime)
  })

  createEffect(() => {
    if (sharedActivityMap() !== null) return
    onCleanup(
      startLocalBadgePoll(badgePollIo(props.vendor, props.worktree), {
        isPrimed: () => primed,
        prime: (mtime) => {
          primed = true
          setBaseline(mtime)
        },
        setLatest,
      }),
    )
  })
  const hasNewActivity = () => primed && latest() > baseline()
  const cornerBadge = () => (hasNewActivity() ? { text: t("ops.badge.newActivity"), active: true } : null)
  function ackActivity(): void {
    setBaseline(latest())
  }

  onMount(() => {
    if (!props.targetPane) return
    onCleanup(
      startTurnStatusPoll(
        {
          worktree: props.worktree,
          detector: createEngineTurnDetector(props.vendor),
          usingShared: () => sharedActivityMap() !== null,
          sharedEntry,
        },
        turnStatusIo(props.targetPane),
      ),
    )
  })

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <FileTree
        worktreePath={() => props.worktree}
        focused={() => true}
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
