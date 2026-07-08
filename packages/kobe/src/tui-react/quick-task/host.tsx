/** @jsxImportSource @opentui/react */
/**
 * `kobe quick-task` — prompt-first fast task creation (`<prefix> f`). React
 * port of `src/tui/quick-task/host.tsx`. React is the default runtime since
 * 2026-07-07 (`uiFramework()` in `src/env.ts`).
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
import { useEffect, useRef } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { engineDisplayName } from "../../engine/interactive-command.ts"
import { addSavedRepo, getSavedRepos } from "../../state/repos.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import { getSessionOptions, tmuxSessionName } from "../../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../../tmux/prompt-delivery.ts"
import { appendAttachmentRefs } from "../../tui/lib/attachments.ts"
import { DEFAULT_BASE_REF, getCurrentBranch } from "../../tui/lib/git-snapshot.ts"
import { expandHome } from "../../tui/lib/path-helpers.ts"
import { ensureTaskSession, jumpToTask } from "../../tui/lib/task-enter.ts"
import { repoBasename } from "../../tui/panes/sidebar/groups.ts"
import type { Task, VendorId } from "../../types/task.ts"
import { QuickTaskComposer } from "../component/quick-task-composer"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { NewTaskPage } from "../new-task/host.tsx"
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

  // Engine: the repo's preferred vendor, clamped to a detected one. With
  // nothing detected we keep the preference (the dialog-less path can't ask).
  const detected = await availableEngineIds()
  const pref = resolvePreferredVendor(repo)
  const vendor: VendorId = detected.length === 0 || detected.includes(pref) ? pref : (detected[0] ?? pref)
  const baseRef = getCurrentBranch(expandHome(repo)) ?? DEFAULT_BASE_REF
  // The composer needs at least the chosen vendor to render its chip even when
  // nothing is detected (offline / PATH miss).
  const engines = detected.length > 0 ? detected : [vendor]
  return { ctx: { repo, vendor, baseRef, engines }, fallbackRepo }
}

/**
 * Deliver a freshly-created task's first prompt. Mirrors `kobe api add`'s
 * deliver path: build the session with the "none" prompt-delivery intent
 * (`ensureTaskSession`'s default), wait for the engine pane, then
 * bracketed-paste + submit. Best-effort.
 */
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
  const started = useRef(false)

  useEffect(() => {
    // One-shot: React can invoke an effect twice (StrictMode); the composer
    // drives a process.exit, so a second `run()` must never open a second
    // dialog.
    if (started.current) return
    started.current = true
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

    setRepoLastActiveVendor(ctx.repo, result.vendor)
    addSavedRepo(ctx.repo)

    const orch = props.orchestrator
    if (!orch) {
      console.error("[kobe quick-task] no daemon; cannot create task")
      process.exit(1)
    }

    try {
      const task = await orch.createTask({ repo: ctx.repo, baseRef: result.baseRef, vendor: result.vendor })
      // The composer requires a non-empty prompt, so always deliver, then jump
      // the attached client into the new task. Attachment paths ride along as
      // `images[n]: /path` reference lines — the engine reads the files itself.
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
