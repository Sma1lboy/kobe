/**
 * `kobe ops` host — the Ops pane on the right side of a task's tmux
 * session (v0.6 / KOB-233).
 *
 * Reuses the v0.5 `FileTree` to browse the worktree. Activating a file
 * (enter / click) is a one-key "just open it": it opens the file in the
 * user's nvim/vim in a fresh tmux window — side-by-side `nvim -d` diff vs
 * HEAD when the file has changes, a plain editable open when it doesn't.
 * Only when no nvim/vim is installed does it fall back to our own built-in
 * **full-width preview window** — a fresh tmux window running
 * `kobe ops --preview <file>` (`./preview.tsx`), which renders opentui's
 * `<diff>` / `<code>`, closed with `q` back to the three-pane layout. So
 * nvim is the primary surface and the opentui preview is the last-resort
 * fallback.
 *
 * Runs in its own OS process inside the tmux pane (separate opentui
 * render loop from the outer kobe TUI). It can't share the outer TUI's
 * Solid runtime, but it DOES inherit the user's theme: host-boot reads
 * the persisted prefs at boot (read-only — the outer app owns
 * `state.json`) and re-applies them live from the daemon's `ui-prefs`
 * channel (UiPrefsSync).
 *
 * File-size-cap split (issue #15 G3): the preview window lives in
 * `./preview.tsx`; the poll loops (badge fallback + turn status) in the
 * framework-free `./activity-monitor.ts`; shell actions + concrete IO in
 * `./host-io.ts` — all shared verbatim with the React port
 * (`src/tui-react/ops/`). This file owns only the Solid reactivity.
 */

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
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
  /** Task engine vendor — selects which transcript store the activity badge polls. */
  readonly vendor: VendorId
}

// Poll-cadence constants + the pure backoff curves live in `./activity-poll`,
// the loop bodies in `./activity-monitor` (host.tsx can't be imported under
// vitest — it pulls @opentui render assets — so the testable logic is
// factored out). The daemon's `transcript.activity` channel does the
// shareable filesystem half; the loops govern only the local fallback (badge
// mtime probe) and the always-in-process tmux capture-pane quiescence poll.

function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()
  const actions = makeOpsActions(props)

  // Visual prefs (theme / transparent / focus accent) are applied
  // centrally — boot + live `ui-prefs` pushes — by host-boot's
  // UiPrefsSync; this shell no longer re-applies them itself.

  // ONE scoped pane orchestrator for the daemon's `transcript.activity`
  // channel (perf — deduplicate per-Ops-pane polling). The daemon runs a
  // single collector that does the SHAREABLE filesystem half — newest
  // transcript mtime + the engine-owned completion marker — for every
  // worktree; this pane reads its worktree's slice instead of stat'ing +
  // parsing the transcript store on its own timers. Non-spawning + leak-
  // guarded, the same pattern host-boot's UiPrefsSync uses: a helper pane
  // must never resurrect an idle-stopped daemon, and a connect that resolves
  // after cleanup is disposed on the spot. When there's no daemon (null
  // orchestrator) OR the daemon predates the channel (signal stays null), the
  // local fallback below engages verbatim — the per-window tmux capture-pane
  // quiescence check + @kobe_tab_state write ALWAYS stay in this process.
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
  // The daemon-collected facts for THIS worktree, or `null` when there's no
  // daemon-collected data (no daemon yet, or an old daemon without the
  // channel) — that null is the fallback trigger throughout this component.
  const sharedActivityMap = () => activityOrch()?.transcriptActivitySignal()() ?? null
  const sharedEntry = (): TranscriptActivity | null => sharedActivityMap()?.get(props.worktree) ?? null

  // New-activity badge (KOB-254). v0.6 has no chat-stream "done" signal and
  // we explicitly don't parse the tmux pane, so the engine's own transcript
  // store (the JSONL the cost dashboard reads) is the source: light a corner
  // badge when its newest mtime advances past what we last acknowledged.
  // `baseline` starts at "now's newest" so a pane that mounts onto an
  // already-busy task doesn't flash stale activity; it's pushed forward on
  // each `r` refresh (the user's "I've looked"). The mtime SOURCE is the
  // daemon's `transcript.activity` push when available, falling back to the
  // local `latestTranscriptMtime` probe only when no daemon-collected data
  // exists.
  const [baseline, setBaseline] = createSignal(0)
  const [latest, setLatest] = createSignal(0)
  let primed = false

  // Shared-source badge: read the daemon-pushed mtime for this worktree. Seed
  // the baseline on the first NON-ZERO mtime (an empty/just-connected map
  // reads 0 — not real activity), then track advances. Inactive (returns
  // early) whenever there's no daemon-collected data, leaving the local
  // fallback effect below in charge.
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

  // Local fallback badge poll — runs ONLY while there's no daemon-collected
  // data (`sharedActivityMap()` null: no daemon, or an old daemon without the
  // channel). Verbatim the pre-daemon adaptive-backoff loop (the body lives
  // in `activity-monitor.ts`). The effect tears it down the instant the
  // daemon channel becomes available (Solid runs the prior run's onCleanup
  // before re-running) and restarts it if a reconnect downgrades to a daemon
  // without the channel.
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

  // Per-window turn detector (loop body in `activity-monitor.ts`). The
  // engine adapter owns transcript-specific completion markers; this pane
  // owns only the tmux-local quiescence check for its paired engine pane, so
  // sibling ChatTabs on the same worktree don't report done unless THIS
  // window actually changed. The `usingShared` / `sharedEntry` getters read
  // the live signal from inside the loop's async ticks (untracked — the loop
  // is not reactive, it just always sees the latest value).
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
  // No KV / Focus providers — the FileTree never touches persisted UI
  // state or pane focus; this pane has always been Theme > Dialog only.
  await bootPaneHost({
    logContext: "ops",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <OpsShell {...args} /> }),
  })
}
