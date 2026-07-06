import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { addSavedRepo, getSavedRepos } from "../../state/repos.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import type { Task } from "../../types/task.ts"
import { NewTaskDialog } from "../component/new-task-dialog"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { jumpToTask } from "../lib/task-enter.ts"
import { useDialog } from "../ui/dialog"

export interface NewTaskHostArgs {
  readonly defaultRepo?: string
}

export function NewTaskPage(props: NewTaskHostArgs & { orchestrator: RemoteOrchestrator | null }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  onMount(() => {
    void run()
  })

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
