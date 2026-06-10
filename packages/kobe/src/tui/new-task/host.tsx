/**
 * `kobe new-task` — the new-task flow rendered as a standalone
 * full-window surface (the default `chattab` settings surface; see
 * `tui/lib/settings-surface.ts`).
 *
 * Same shape as `tui/settings/host.tsx`: this reuses the SAME
 * `NewTaskDialog` the in-pane `taskpanel` surface opens (reuse the real
 * dialog, don't improvise a parallel one), only here it fills its own
 * tmux window instead of overlaying the Tasks pane. Opened by
 * `openNewTaskTab`.
 *
 * Unlike the overlay — which resolves a result the Tasks pane then acts
 * on — this page is its own process, so it performs the create / adopt
 * against its own daemon connection and then exits. tmux closes the
 * window and returns to the previous tab; the new task shows up in every
 * Tasks pane via the daemon subscribe. The create/adopt branch mirrors
 * the Tasks pane's `createTask` exactly so the two surfaces stay in
 * lockstep.
 */

import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { addSavedRepo, getPersistedString, getSavedRepos, setPersistedString } from "../../state/repos.ts"
import { DEFAULT_TASK_VENDOR, type VendorId } from "../../types/task.ts"
import { NewTaskDialog } from "../component/new-task-dialog"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useDialog } from "../ui/dialog"

export interface NewTaskHostArgs {
  /** Default repo to pre-select (the Tasks pane's cursor-task repo). */
  readonly defaultRepo?: string
}

export function NewTaskPage(props: NewTaskHostArgs & { orchestrator: RemoteOrchestrator | null }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  // Open the dialog once mounted, run the same create/adopt the Tasks
  // pane runs, then exit (closing the tmux window). Cancel → exit 0.
  onMount(() => {
    void run()
  })

  async function run(): Promise<void> {
    const repos = getSavedRepos()
    const defaultRepo = props.defaultRepo || repos[0] || process.cwd()
    const defaultVendor = (getPersistedString("lastSelectedVendor") as VendorId | undefined) ?? DEFAULT_TASK_VENDOR
    const availableVendors = await availableEngineIds()
    const orch = props.orchestrator

    const result = await NewTaskDialog.show(dialog, defaultRepo, repos, {
      defaultVendor,
      availableVendors,
      discoverAdoptable: orch ? (repo) => orch.discoverAdoptableWorktrees(repo) : undefined,
    })
    if (!result) {
      process.exit(0)
    }

    // Remember the choices (shared kv state.json) so the next new-task
    // dialog — here or in any Tasks pane — defaults to them.
    setPersistedString("lastSelectedVendor", result.vendor)
    addSavedRepo(result.repo)

    if (!orch) {
      console.error("[kobe new-task] no daemon; cannot create task")
      process.exit(1)
    }

    try {
      if (result.mode === "adopt") {
        for (const w of result.adopt) {
          await orch.adoptWorktree({
            repo: result.repo,
            worktreePath: w.worktreePath,
            branch: w.branch,
            vendor: result.vendor,
          })
        }
      } else {
        await orch.createTask({
          repo: result.repo,
          baseRef: result.baseRef,
          vendor: result.vendor,
        })
      }
    } catch (err) {
      console.error("[kobe new-task] task.create/adopt failed:", err)
      process.exit(1)
    }
    process.exit(0)
  }

  // The dialog renders itself on the DialogProvider overlay; this box is
  // just the (transparent) page backdrop behind the centered card.
  return <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} />
}

export async function startNewTaskHost(args: NewTaskHostArgs): Promise<void> {
  await bootPaneHost({
    setup: async () => {
      let orch: RemoteOrchestrator | null = null
      try {
        const client = await connectOrStartDaemon()
        const remote = new RemoteOrchestrator(client)
        await remote.init()
        orch = remote
      } catch (err) {
        console.error("[kobe new-task] daemon unavailable; cannot create task:", err)
      }
      return {
        root: () => <NewTaskPage defaultRepo={args.defaultRepo} orchestrator={orch} />,
        onDestroy: () => {
          orch?.dispose()
        },
      }
    },
  })
}
