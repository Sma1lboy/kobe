import { homedir } from "node:os"
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { CodexLocal } from "../engine/codex-local/index.ts"
import type { EngineMap } from "../engine/registry.ts"
import { type BridgeHandles, startBridge } from "../orchestrator/bridge/index.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import type { AIEngine } from "../types/engine.ts"

export interface KobeCoreOptions {
  readonly homeDir?: string
  /**
   * Single-engine override (back-compat). When supplied, it replaces the
   * default claude/codex pair. Test fixtures use this to inject the
   * FakeAIEngine.
   */
  readonly engine?: AIEngine
  /**
   * Per-vendor engine override. When supplied, replaces the default
   * production map (claude + codex). If both `engine` and `engines`
   * are passed, `engines` takes full precedence and `engine` is ignored.
   */
  readonly engines?: EngineMap
  readonly startMcpBridge?: boolean
}

export interface KobeCore {
  readonly homeDir: string
  readonly orchestrator: Orchestrator
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
  readonly bridge: BridgeHandles | null
  close(): Promise<void>
}

export async function createKobeCore(options: KobeCoreOptions = {}): Promise<KobeCore> {
  const homeDir = options.homeDir ?? process.env.KOBE_HOME_DIR ?? homedir()
  const store = new TaskIndexStore({ homeDir })
  await store.load()

  const worktrees = new GitWorktreeManager()
  // Production default: register both vendors. Tests pass `options.engine`
  // to swap in a FakeAIEngine and skip the production map.
  const engines: EngineMap =
    options.engines ??
    (options.engine
      ? { [options.engine.capabilities.vendorId]: options.engine }
      : {
          claude: new ClaudeCodeLocal(),
          codex: new CodexLocal(),
        })
  const orchestrator = new Orchestrator({ engines, store, worktrees })
  const bridge = options.startMcpBridge === false ? null : await startBridge(orchestrator, { homeDir })

  return {
    homeDir,
    orchestrator,
    store,
    worktrees,
    bridge,
    async close() {
      // Order matters: stop live engine sessions BEFORE we tear down
      // the bridge (so any final mcp-bridge tool call replies cleanly)
      // and BEFORE dispose() drops the store subscription. Without
      // this, a graceful daemon shutdown (`kobed stop`, SIGTERM) left
      // claude/codex subprocesses orphaned to init, where they'd keep
      // running models and writing transcript indefinitely.
      await orchestrator.stopAllSessions()
      await bridge?.close()
      orchestrator.dispose()
    },
  }
}
