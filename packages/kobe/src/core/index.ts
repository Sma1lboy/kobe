/**
 * Public bootstrap for the kobe "core" — the orchestrator + worktree
 * manager + task index, wired together with sensible defaults. v0.5
 * had an engine port (and an MCP bridge that exposed it to spawned
 * claude); both are gone in v0.6.
 */

import { homedir } from "node:os"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"

export interface KobeCoreOptions {
  readonly homeDir?: string
}

export interface KobeCore {
  readonly homeDir: string
  readonly orchestrator: Orchestrator
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
  close(): Promise<void>
}

export async function createKobeCore(options: KobeCoreOptions = {}): Promise<KobeCore> {
  const homeDir = options.homeDir ?? process.env.KOBE_HOME_DIR ?? homedir()
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const worktrees = new GitWorktreeManager()
  const orchestrator = new Orchestrator({ store, worktrees })

  return {
    homeDir,
    orchestrator,
    store,
    worktrees,
    async close() {
      orchestrator.dispose()
    },
  }
}
