/**
 * `kobe quick-task` — prompt-only fast task creation (`<prefix> f`).
 *
 * The quick-create chord opens this as a dedicated full-window page (via
 * `quickCreate` → `newWindow`, mirroring `openNewTaskTab`). Unlike the full
 * `kobe new-task` dialog — which asks for repo + base branch + engine — this
 * surface asks for ONLY a prompt and fills everything else from defaults
 * derived from the task the chord was fired in:
 *
 *   - repo    = that task's source repo (its session's `@kobe_task` record),
 *               falling back to the first saved repo.
 *   - vendor  = the last-selected engine, clamped to a DETECTED vendor.
 *   - baseRef = the repo's current branch, else `main`.
 *   - model   = the engine's own default (kobe has no model field).
 *
 * On submit it creates the task and delivers the typed prompt as its first
 * message (the same readiness-wait + bracketed paste `kobe api add --prompt`
 * uses — `initScript` only, so the repo's init-prompt isn't ALSO pasted),
 * then exits; tmux closes the window and returns to the previous tab.
 *
 * Fallback: if no repo can be resolved (no current task, no saved repos — the
 * rare first-run case), it renders the FULL `NewTaskPage` instead of a
 * prompt-only flow, so creation is never a dead end.
 */

import { render } from "@opentui/solid"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { addSavedRepo, getPersistedString, getSavedRepos, setPersistedString } from "../../state/repos.ts"
import { getSessionOptions, sessionExists, tmuxSessionName } from "../../tmux/client.ts"
import { pasteAndSubmit, waitForEnginePane } from "../../tmux/prompt-delivery.ts"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "../../types/task.ts"
import { DEFAULT_BASE_REF, expandHome, getCurrentBranch } from "../component/new-task-dialog/state.ts"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { FocusProvider } from "../context/focus"
import { KVProvider } from "../context/kv"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { NewTaskPage } from "../new-task/host.tsx"
import { repoBasename } from "../panes/sidebar/groups"
import { DialogProvider, useDialog } from "../ui/dialog"

const FALLBACK_THEME = "claude"

export interface QuickTaskHostArgs {
  /** The task session the chord fired in — its `@kobe_task` repo is the default. */
  readonly session?: string
}

/** Resolved prompt-only defaults; null when no repo could be found (→ full dialog). */
interface QuickTaskContext {
  readonly repo: string
  readonly vendor: VendorId
  readonly baseRef: string
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
  return { ctx: { repo, vendor, baseRef }, fallbackRepo }
}

/**
 * Deliver a freshly-created task's first prompt. Mirrors `kobe api add`'s
 * deliver path: ensure the worktree, build the session with the init SCRIPT
 * only (no init-prompt, so this typed prompt isn't double-pasted), wait for
 * the engine pane, then bracketed-paste + submit. Best-effort on the pane.
 */
async function deliverFirstPromptToTask(
  orch: RemoteOrchestrator,
  task: Task,
  ctx: QuickTaskContext,
  prompt: string,
): Promise<void> {
  let worktree = task.worktreePath
  if (!worktree) worktree = await orch.ensureWorktree(task.id)
  if (!worktree) throw new Error(`task ${task.id} has no worktree`)

  const session = tmuxSessionName(task.id)
  const existed = await sessionExists(session)
  if (!existed) {
    const { ensureSession } = await import("../panes/terminal/tmux.ts")
    const { resolveRepoInit } = await import("../../state/repo-init.ts")
    const init = resolveRepoInit(ctx.repo, worktree)
    const ok = await ensureSession({
      name: session,
      cwd: worktree,
      command: interactiveEngineCommand(ctx.vendor),
      taskId: task.id,
      vendor: ctx.vendor,
      initScript: init.initScript,
    })
    if (!ok) throw new Error(`failed to start tmux session for ${task.id}`)
  }

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
    const prompt = await RenameTaskDialog.show(dialog, "", {
      dialogTitle: `Quick task · ${repoBasename(ctx.repo)} · ${ctx.vendor}`,
    })
    if (prompt === undefined) process.exit(0) // esc

    // Remember the choices so the next dialog (here or any pane) matches.
    setPersistedString("lastSelectedVendor", ctx.vendor)
    addSavedRepo(ctx.repo)

    const orch = props.orchestrator
    if (!orch) {
      console.error("[kobe quick-task] no daemon; cannot create task")
      process.exit(1)
    }

    try {
      const task = await orch.createTask({ repo: ctx.repo, baseRef: ctx.baseRef, vendor: ctx.vendor })
      const text = prompt.trim()
      if (text) await deliverFirstPromptToTask(orch, task, ctx, text)
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
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)

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

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <KVProvider>
          <FocusProvider initial="sidebar">
            <DialogProvider>
              {ctx ? (
                <QuickTaskPage ctx={ctx} orchestrator={orch} />
              ) : (
                <NewTaskPage defaultRepo={fallbackRepo} orchestrator={orch} />
              )}
            </DialogProvider>
          </FocusProvider>
        </KVProvider>
      </ThemeProvider>
    ),
    {
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
      onDestroy: () => {
        orch?.dispose()
      },
    },
  )
}
