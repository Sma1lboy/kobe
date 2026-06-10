/**
 * `kobe quick-task` — prompt-first fast task creation (`<prefix> f`).
 *
 * The quick-create chord opens this as a dedicated full-window page (via
 * `quickCreate` → `newWindow`, mirroring `openNewTaskTab`). It's prompt-first:
 * the {@link QuickTaskComposer} focuses a PROMPT field and `enter` creates the
 * task immediately. Engine and branch are right there (`tab` / `ctrl+e`) but
 * default from the task the chord fired in, so the common path is type-and-go:
 *
 *   - repo    = that task's source repo (its session's `@kobe_task` record),
 *               falling back to the first saved repo. NOT editable here (use
 *               the full `n` dialog to pick a different repo).
 *   - vendor  = the last-selected engine, clamped to a detected one — editable.
 *   - baseRef = the repo's current branch, else `main` — editable.
 *   - model   = the engine's own default (kobe has no model field).
 *
 * On submit it creates the task, delivers the typed prompt as the first engine
 * message (the same readiness-wait + bracketed paste `kobe api add --prompt`
 * uses — `initScript` only, so the repo's init-prompt isn't ALSO pasted), then
 * JUMPS the attached client into the new task (`switch-client` + setActiveTask)
 * and exits.
 *
 * Fallback: if no repo can be resolved (no current task, no saved repos — the
 * rare first-run case), it renders the FULL `NewTaskPage` instead, so creation
 * is never a dead end.
 */

import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { engineDisplayName, interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { addSavedRepo, getPersistedString, getSavedRepos, setPersistedString } from "../../state/repos.ts"
import { getSessionOptions, runTmux, sessionExists, tmuxSessionName } from "../../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../../tmux/prompt-delivery.ts"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "../../types/task.ts"
import { QuickTaskComposer } from "../component/quick-task-composer"
import { useTheme } from "../context/theme"
import { DEFAULT_BASE_REF, getCurrentBranch } from "../lib/git-snapshot.ts"
import { bootPaneHost } from "../lib/host-boot"
import { expandHome } from "../lib/path-helpers.ts"
import { NewTaskPage } from "../new-task/host.tsx"
import { repoBasename } from "../panes/sidebar/groups"
import { useDialog } from "../ui/dialog"

export interface QuickTaskHostArgs {
  /** The task session the chord fired in — its `@kobe_task` repo is the default. */
  readonly session?: string
}

/** Resolved prompt-first defaults; null when no repo could be found (→ full dialog). */
interface QuickTaskContext {
  readonly repo: string
  readonly vendor: VendorId
  readonly baseRef: string
  /** Engines to offer in the composer (detected built-ins + custom). */
  readonly engines: readonly VendorId[]
}

/**
 * Derive the prompt-only defaults from the firing task's session. Returns
 * null when no repo can be resolved, so the caller falls back to the full
 * new-task dialog. `fallbackRepo` is the best default-repo guess for that
 * fallback (worktree → cwd).
 */
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

  // Engine: last-selected vendor, clamped to a detected one. With nothing
  // detected we keep the preference (the dialog-less path can't ask).
  const detected = await availableEngineIds()
  const pref = (getPersistedString("lastSelectedVendor") as VendorId | undefined) ?? DEFAULT_TASK_VENDOR
  const vendor: VendorId = detected.length === 0 || detected.includes(pref) ? pref : (detected[0] ?? pref)
  const baseRef = getCurrentBranch(expandHome(repo)) ?? DEFAULT_BASE_REF
  // The composer needs at least the chosen vendor to render its chip even when
  // nothing is detected (offline / PATH miss).
  const engines = detected.length > 0 ? detected : [vendor]
  return { ctx: { repo, vendor, baseRef, engines }, fallbackRepo }
}

/**
 * Deliver a freshly-created task's first prompt. Mirrors `kobe api add`'s
 * deliver path: ensure the worktree, build the session with the init SCRIPT
 * only (no init-prompt, so this typed prompt isn't double-pasted), wait for
 * the engine pane, then bracketed-paste + submit. Best-effort on the pane.
 */
async function ensureTaskSession(
  orch: RemoteOrchestrator,
  task: Task,
  repo: string,
  vendor: VendorId,
): Promise<boolean> {
  const session = tmuxSessionName(task.id)
  if (await sessionExists(session)) return true
  let worktree = task.worktreePath
  if (!worktree) worktree = await orch.ensureWorktree(task.id)
  if (!worktree) throw new Error(`task ${task.id} has no worktree`)
  const { ensureSession } = await import("../panes/terminal/tmux.ts")
  const { resolveRepoInit } = await import("../../state/repo-init.ts")
  const init = resolveRepoInit(repo, worktree)
  const ok = await ensureSession({
    name: session,
    cwd: worktree,
    command: interactiveEngineCommand(vendor),
    taskId: task.id,
    vendor,
    repo,
    initScript: init.initScript,
  })
  if (!ok) throw new Error(`failed to start tmux session for ${task.id}`)
  return false // freshly built
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

/**
 * Jump the attached client to the freshly-created task: mark it active and
 * `switch-client` to its tmux session (the session already exists — deliver
 * built it). Mirrors the Tasks pane's `switchTo`. The quick-task window then
 * exits; the client is already on the new task's session, so closing the old
 * window doesn't disturb it.
 */
async function jumpToTask(orch: RemoteOrchestrator, task: Task, repo: string, vendor: VendorId): Promise<void> {
  await ensureTaskSession(orch, task, repo, vendor) // no-op if deliver already built it
  await orch.setActiveTask(task.id).catch(() => {})
  await runTmux(["switch-client", "-t", `=${tmuxSessionName(task.id)}`])
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
    if (result === undefined) process.exit(0) // esc

    // Remember the chosen engine so the next dialog (here or any pane) matches.
    setPersistedString("lastSelectedVendor", result.vendor)
    addSavedRepo(ctx.repo)

    const orch = props.orchestrator
    if (!orch) {
      console.error("[kobe quick-task] no daemon; cannot create task")
      process.exit(1)
    }

    try {
      const task = await orch.createTask({ repo: ctx.repo, baseRef: result.baseRef, vendor: result.vendor })
      // The composer requires a non-empty prompt, so always deliver, then jump
      // the attached client into the new task.
      await deliverFirstPromptToTask(orch, task, ctx.repo, result.vendor, result.prompt)
      await jumpToTask(orch, task, ctx.repo, result.vendor)
    } catch (err) {
      console.error("[kobe quick-task] task.create/deliver failed:", err)
      process.exit(1)
    }
    process.exit(0)
  }

  // The prompt input renders on the DialogProvider overlay; this box is the
  // transparent page backdrop behind the centered card.
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
