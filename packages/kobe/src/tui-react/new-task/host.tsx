/** @jsxImportSource @opentui/react */
/**
 * `kobe new-task` — React port of `src/tui/new-task/host.tsx` (the Solid
 * host removed in 7a5b878d). React is the default runtime since 2026-07-07
 * (`uiFramework()` in `src/env.ts`). Same contract: the new-task flow
 * rendered as a standalone full-window surface (the default `chattab`
 * settings surface; see `tui/lib/settings-surface.ts`).
 *
 * Same shape as `tui-react/settings/host.tsx`: this reuses the SAME
 * `NewTaskDialog` the in-pane `taskpanel` surface opens (reuse the real
 * dialog, don't improvise a parallel one), only here it fills its own
 * tmux window instead of overlaying the Tasks pane. Opened by
 * `openNewTaskTab`.
 *
 * Unlike the overlay — which resolves a result the Tasks pane then acts
 * on — this page is its own process, so it performs the create / adopt
 * against its own daemon connection, then JUMPS the attached client into
 * the new (or last-adopted) task — building its session so the user lands
 * in the engine pane ready to type the first prompt — and exits. tmux
 * closes this window; the client is already on the new task's session. The
 * new task also shows up in every Tasks pane via the daemon subscribe. The
 * create/adopt + auto-enter branch mirrors the Tasks pane's `createTask`
 * (and `quick-task`'s jump) so the surfaces stay in lockstep.
 */

import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { useEffect, useRef } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { addSavedRepo, getSavedRepos } from "../../state/repos.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import { jumpToTask } from "../../tui/lib/task-enter.ts"
import type { Task } from "../../types/task.ts"
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
  // One-shot guard: open the dialog + run the create/adopt exactly once,
  // even if the mount effect were ever re-invoked.
  const ran = useRef(false)

  // Open the dialog once mounted, run the same create/adopt the Tasks
  // pane runs, then exit (closing the tmux window). Cancel → exit 0.
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void run()
  }, [])

  async function run(): Promise<void> {
    const repos = getSavedRepos()
    const defaultRepo = props.defaultRepo || repos[0] || process.cwd()
    const defaultVendor = resolvePreferredVendor(defaultRepo)
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

    setRepoLastActiveVendor(result.repo, result.vendor)
    addSavedRepo(result.repo)

    if (!orch) {
      console.error("[kobe new-task] no daemon; cannot create task")
      process.exit(1)
    }

    let entered: Task | undefined
    try {
      if (result.mode === "adopt") {
        // Adopt one or more existing worktrees; enter the LAST one (mirrors the
        // Tasks pane's "focus the last adopted").
        for (const w of result.adopt) {
          entered = await orch.adoptWorktree({
            repo: result.repo,
            worktreePath: w.worktreePath,
            branch: w.branch,
            vendor: result.vendor,
          })
        }
      } else {
        entered = await orch.createTask({
          repo: result.repo,
          baseRef: result.baseRef,
          vendor: result.vendor,
        })
      }
    } catch (err) {
      console.error("[kobe new-task] task.create/adopt failed:", err)
      process.exit(1)
    }

    // Auto-enter the new (or last-adopted) task: build its session and jump the
    // attached client into it, landing the user in the engine pane ready to
    // type. A create lets the repo's init-prompt fire as the engine's first
    // message; an adopt imports existing work, so it doesn't paste a first-run
    // prompt. Then exit; the client is already on the new session, so closing
    // this window doesn't disturb it. Non-fatal: the task is already created,
    // so a jump failure (e.g. run outside a kobe tmux session) still exits 0 —
    // the user can enter it from any Tasks pane.
    if (entered) {
      try {
        await jumpToTask(orch, entered, result.repo, result.vendor, {
          includeInitPrompt: result.mode !== "adopt",
        })
      } catch (err) {
        console.error("[kobe new-task] auto-enter failed:", err)
      }
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
