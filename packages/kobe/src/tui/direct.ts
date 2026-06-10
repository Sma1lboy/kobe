/**
 * Direct tmux entrypoint (v0.6 inner-first).
 *
 * The old opentui "outer monitor" is now a deprecated fallback. The
 * default `kobe` path should put the user straight inside the tmux
 * workspace; task switching, task creation, Ops, and shell live there.
 */

import { resolve } from "node:path"
import { setClientLogContext } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { deriveTitleFromSession } from "../monitor/auto-title.ts"
import { PLACEHOLDER_TASK_TITLE } from "../orchestrator/core.ts"
import { resolveRepoInit } from "../state/repo-init.ts"
import {
  addSavedRepo,
  getPersistedString,
  getSavedRepos,
  normalizeSavedRepos,
  setPersistedString,
} from "../state/repos.ts"
import { ensureFallbackSession } from "../tmux/client.ts"
import type { Task } from "../types/task.ts"
import { applyTmuxPaneBorderTheme } from "./lib/tmux-border-theme.ts"
import {
  attachArgv,
  ensureSession,
  prepareWindowForAttach,
  sessionExists,
  tmuxAvailable,
  tmuxSessionName,
} from "./panes/terminal/tmux.ts"

export interface InitialTaskChoice {
  readonly activeTaskId?: string | null
  readonly persistedTaskId?: string | null
  readonly cwdRepo?: string
}

/** Pick the task direct mode should attach first. Exported for unit coverage. */
export function chooseInitialTask(tasks: readonly Task[], choice: InitialTaskChoice = {}): Task | undefined {
  const byId = (id: string | null | undefined) => (id ? tasks.find((t) => t.id === id) : undefined)
  const active = byId(choice.activeTaskId)
  if (active) return active
  const persisted = byId(choice.persistedTaskId)
  if (persisted) return persisted
  if (choice.cwdRepo) {
    const cwdMain = tasks.find((t) => t.kind === "main" && t.repo === choice.cwdRepo)
    if (cwdMain) return cwdMain
  }
  const visible = tasks.filter((t) => !t.archived)
  return visible.find((t) => t.pinned) ?? visible[0] ?? tasks[0]
}

async function attachTmux(command: readonly string[]): Promise<number | null> {
  if (command.length === 0) return null
  try {
    const proc = Bun.spawn(command as string[], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    return await proc.exited
  } catch {
    return null
  }
}

async function ensureRepos(orchestrator: KobeOrchestrator): Promise<string> {
  normalizeSavedRepos()
  let repos = [...getSavedRepos()]
  if (repos.length === 0) {
    const added = addSavedRepo(resolve(process.cwd()))
    repos = [added.path]
  }
  for (const repo of repos) {
    try {
      await orchestrator.ensureMainTask(repo)
    } catch (err) {
      console.error(`[kobe] ensureMainTask failed for ${repo}:`, err)
    }
  }
  return repos[0] ?? resolve(process.cwd())
}

export async function startDirectTmux(): Promise<void> {
  setClientLogContext("gui")
  // Install kobe's global hooks on launch (activity events + default-on
  // external-worktree sync) into ~/.claude/settings.json — no-op when already
  // in place or the user opted out. Fire-and-forget: best-effort config, must
  // never delay or fail the launch.
  void import("../cli/hook-cmd.ts").then((m) => m.ensureGlobalKobeHooks())
  if (!(await tmuxAvailable())) {
    console.error("kobe: tmux not found on PATH — install tmux to use kobe 0.6 direct mode")
    process.exitCode = 1
    return
  }

  // Direct mode cannot depend on an outer opentui process staying alive
  // after detach. Use the stable daemon socket so in-session Tasks/Ops
  // panes survive `Ctrl+Q` and a later `kobe` relaunch.
  const client = await connectOrStartDaemon()
  // role: "gui" — this is THE front-end attach. It stays parked on
  // `tmux attach` for the whole session and disposes on quit, so it is the
  // correct (and only) signal for the daemon's lazy-shutdown refcount. The
  // in-tmux Tasks/Ops panes subscribe as "pane" and never hold the daemon.
  const orchestrator = new RemoteOrchestrator(client, { role: "gui" })
  try {
    process.env.KOBE_DAEMON_SOCKET_PATH = client.socketPath
    await orchestrator.init()
    const cwdRepo = await ensureRepos(orchestrator)
    const task = chooseInitialTask(orchestrator.listTasks(), {
      activeTaskId: orchestrator.activeTaskSignal()(),
      persistedTaskId: getPersistedString("lastSelectedTaskId"),
      cwdRepo,
    })
    if (!task) {
      // Zero tasks to enter: park on the kobe-home Tasks home instead of
      // bailing to the launching shell. From there the user can create
      // (`n`) a task and switch straight into it; deleting the last task
      // lands back here too (switchClientBeforeKill). No task → no
      // auto-title pass, so we attach and return directly.
      const home = await ensureFallbackSession()
      // Fallback sessions skip ensureSession's server-nicety block, so
      // apply the theme-matched borders here before attaching.
      await applyTmuxPaneBorderTheme()
      // Fit + heal the window before attaching so the first frame is correct
      // (no reflow flash on attach — see prepareWindowForAttach).
      await prepareWindowForAttach(home)
      if ((await attachTmux(attachArgv(home))) === null) {
        console.error("kobe: failed to attach to the kobe-home session")
        process.exitCode = 1
      }
      return
    }

    const cwd = task.worktreePath || (await orchestrator.ensureWorktree(task.id))
    const name = tmuxSessionName(task.id)
    await orchestrator.setActiveTask(task.id).catch(() => {})
    setPersistedString("lastSelectedTaskId", task.id)
    const init = resolveRepoInit(task.repo, cwd)
    const ready = await ensureSession({
      name,
      cwd,
      command: interactiveEngineCommand(task.vendor),
      taskId: task.id,
      vendor: task.vendor,
      repo: task.repo,
      initScript: init.initScript,
      initPrompt: init.initPrompt,
    })
    if (!ready) {
      console.error(`kobe: tmux session ${name} failed to start (check the daemon log)`)
      process.exitCode = 1
      return
    }

    // ensureSession's reuse path skips the server-nicety block where the
    // create path applies border styling, and the user may have switched
    // themes since the server last saw an apply — refresh before attach.
    await applyTmuxPaneBorderTheme()

    // Fit the window to this terminal and heal the layout BEFORE attaching, so
    // the first painted frame is already correct — no reflow "flash" where the
    // rail blows up on attach and the window-resized hook snaps it back a beat
    // later (see prepareWindowForAttach).
    await prepareWindowForAttach(name)
    const exitCode = await attachTmux(attachArgv(name))
    if (exitCode === null) {
      console.error(`kobe: failed to attach to tmux session ${name}`)
      process.exitCode = 1
      return
    }
    if (exitCode !== 0 && !(await sessionExists(name))) {
      console.error(`kobe: tmux session ${name} ended unexpectedly (attach exited ${exitCode})`)
      process.exitCode = exitCode
      return
    }

    const after = orchestrator.getTask(task.id)
    if (after && after.title === PLACEHOLDER_TASK_TITLE && after.worktreePath) {
      try {
        const title = await deriveTitleFromSession(after.worktreePath, after.vendor)
        if (title) await orchestrator.setTitle(after.id, title)
      } catch (err) {
        console.error("[kobe] auto-title failed:", err)
      }
    }
  } finally {
    orchestrator.dispose()
  }
}
