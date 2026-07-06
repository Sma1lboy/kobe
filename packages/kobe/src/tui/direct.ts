import { resolve } from "node:path"
import { setClientLogContext } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { deriveTitleFromSession } from "../monitor/auto-title.ts"
import { PLACEHOLDER_TASK_TITLE } from "../orchestrator/core.ts"
import { resolveEngineLaunchInit } from "../state/repo-init.ts"
import {
  addSavedRepo,
  getPersistedString,
  getSavedRepos,
  normalizeSavedRepos,
  setPersistedString,
} from "../state/repos.ts"
import { resolvePreferredVendor } from "../state/vendor-prefs.ts"
import { ensureFallbackSession } from "../tmux/client.ts"
import type { Task } from "../types/task.ts"
import { applyTmuxChromeTheme } from "./lib/tmux-border-theme.ts"
import { syncSessionZen } from "./panes/terminal/layout-actions.ts"
import {
  attachArgv,
  ensureSession,
  observeSessionVendor,
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
  void import("../cli/hook-cmd.ts").then((m) => m.ensureGlobalKobeHooks())
  if (!(await tmuxAvailable())) {
    console.error("kobe: tmux not found on PATH — install tmux to use kobe 0.6 direct mode")
    process.exitCode = 1
    return
  }

  const client = await connectOrStartDaemon()
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
      const home = await ensureFallbackSession()
      await applyTmuxChromeTheme()
      await syncSessionZen(home)
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
    let vendor = task.vendor
    if (task.kind === "main") {
      const live = await observeSessionVendor(name)
      const desired = live ?? resolvePreferredVendor(task.repo)
      if (desired !== task.vendor) {
        await orchestrator.setVendor(task.id, desired).catch(() => {})
        vendor = desired
      }
    }
    const launchInit = resolveEngineLaunchInit(task.repo, cwd, { kind: "repo-init" })
    const ready = await ensureSession({
      name,
      cwd,
      command: interactiveEngineCommand(vendor),
      taskId: task.id,
      vendor,
      repo: task.repo,
      launchInit,
    })
    if (!ready) {
      console.error(`kobe: tmux session ${name} failed to start (check the daemon log)`)
      process.exitCode = 1
      return
    }

    await applyTmuxChromeTheme()

    await syncSessionZen(name)
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
