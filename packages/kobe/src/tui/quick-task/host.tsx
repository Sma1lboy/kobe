import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { engineDisplayName } from "../../engine/interactive-command.ts"
import { addSavedRepo, getSavedRepos } from "../../state/repos.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import { getSessionOptions, tmuxSessionName } from "../../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../../tmux/prompt-delivery.ts"
import type { Task, VendorId } from "../../types/task.ts"
import { QuickTaskComposer } from "../component/quick-task-composer"
import { useTheme } from "../context/theme"
import { appendAttachmentRefs } from "../lib/attachments.ts"
import { DEFAULT_BASE_REF, getCurrentBranch } from "../lib/git-snapshot.ts"
import { bootPaneHost } from "../lib/host-boot"
import { expandHome } from "../lib/path-helpers.ts"
import { ensureTaskSession, jumpToTask } from "../lib/task-enter.ts"
import { NewTaskPage } from "../new-task/host.tsx"
import { repoBasename } from "../panes/sidebar/groups"
import { useDialog } from "../ui/dialog"

export interface QuickTaskHostArgs {
  readonly session?: string
}

interface QuickTaskContext {
  readonly repo: string
  readonly vendor: VendorId
  readonly baseRef: string
  readonly engines: readonly VendorId[]
}

async function resolveQuickTaskContext(
  orch: RemoteOrchestrator | null,
  session: string | undefined,
): Promise<{ ctx: QuickTaskContext | null; fallbackRepo: string }> {
  let taskId: string | undefined
  let worktree: string | undefined
  if (session) {
    const opts = await getSessionOptions(session, ["@kobe_task", "@kobe_worktree"])
    taskId = opts["@kobe_task"] || undefined
    worktree = opts["@kobe_worktree"] || undefined
  }
  const repo = (taskId ? orch?.getTask(taskId)?.repo : undefined) ?? getSavedRepos()[0]
  const fallbackRepo = repo ?? worktree ?? process.cwd()
  if (!repo) return { ctx: null, fallbackRepo }

  const detected = await availableEngineIds()
  const pref = resolvePreferredVendor(repo)
  const vendor: VendorId = detected.length === 0 || detected.includes(pref) ? pref : (detected[0] ?? pref)
  const baseRef = getCurrentBranch(expandHome(repo)) ?? DEFAULT_BASE_REF
  const engines = detected.length > 0 ? detected : [vendor]
  return { ctx: { repo, vendor, baseRef, engines }, fallbackRepo }
}

async function deliverFirstPromptToTask(
  orch: RemoteOrchestrator,
  task: Task,
  repo: string,
  vendor: VendorId,
  prompt: string,
): Promise<void> {
  const existed = await ensureTaskSession(orch, task, repo, vendor)
  const session = tmuxSessionName(task.id)
  const { pane } = await waitForEnginePane(session, !existed)
  if (pane) await pasteAndSubmit(pane, prompt)
}

function QuickTaskPage(props: { ctx: QuickTaskContext; orchestrator: RemoteOrchestrator | null }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  onMount(() => {
    void run()
  })

  async function run(): Promise<void> {
    const ctx = props.ctx
    const result = await QuickTaskComposer.show(dialog, {
      repoLabel: repoBasename(ctx.repo),
      engines: ctx.engines,
      defaultVendor: ctx.vendor,
      defaultBaseRef: ctx.baseRef,
      engineLabel: engineDisplayName,
    })
    if (result === undefined) process.exit(0)

    setRepoLastActiveVendor(ctx.repo, result.vendor)
    addSavedRepo(ctx.repo)

    const orch = props.orchestrator
    if (!orch) {
      console.error("[kobe quick-task] no daemon; cannot create task")
      process.exit(1)
    }

    try {
      const task = await orch.createTask({ repo: ctx.repo, baseRef: result.baseRef, vendor: result.vendor })
      await deliverFirstPromptToTask(
        orch,
        task,
        ctx.repo,
        result.vendor,
        appendAttachmentRefs(result.prompt, result.attachments),
      )
      await jumpToTask(orch, task, ctx.repo, result.vendor)
    } catch (err) {
      console.error("[kobe quick-task] task.create/deliver failed:", err)
      process.exit(1)
    }
    process.exit(0)
  }

  return <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} />
}

export async function startQuickTaskHost(args: QuickTaskHostArgs): Promise<void> {
  await bootPaneHost({
    setup: async () => {
      let orch: RemoteOrchestrator | null = null
      try {
        const client = await connectOrStartDaemon()
        const remote = new RemoteOrchestrator(client)
        await remote.init()
        orch = remote
      } catch (err) {
        console.error("[kobe quick-task] daemon unavailable; cannot create task:", err)
      }

      const { ctx, fallbackRepo } = await resolveQuickTaskContext(orch, args.session)

      return {
        root: () =>
          ctx ? (
            <QuickTaskPage ctx={ctx} orchestrator={orch} />
          ) : (
            <NewTaskPage defaultRepo={fallbackRepo} orchestrator={orch} />
          ),
        onDestroy: () => {
          orch?.dispose()
        },
      }
    },
  })
}
