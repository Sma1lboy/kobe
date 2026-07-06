import type { EngineCapabilities, EngineIdentity, Message } from "@/types/engine"
import { type VendorId, isBuiltinVendor } from "@/types/vendor"
import {
  type ClaudeAccount,
  type CodexAccount,
  type CopilotAccount,
  type DetectDeps,
  type EngineAccountStatus,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
} from "./account-detect.ts"
import { claudeCapabilities, claudeIdentity } from "./claude-code-local/capabilities.ts"
import * as claudeHistory from "./claude-code-local/history.ts"
import { ClaudeHookAdapter } from "./claude-code-local/hook-adapter.ts"
import { codexCapabilities, codexIdentity } from "./codex-local/capabilities.ts"
import * as codexHistory from "./codex-local/history.ts"
import { CodexHookAdapter } from "./codex-local/hook-adapter.ts"
import * as copilotHistory from "./copilot-local/history.ts"
import { type EngineHookAdapter, NoopHookAdapter } from "./hook-adapter.ts"
import { ClaudeTurnDetector, CodexTurnDetector, type EngineTurnDetector, UnknownTurnDetector } from "./turn-detector.ts"

export interface EngineHistoryReader {
  listSessionIdsForWorktree(worktree: string): Promise<readonly string[]>
  readHistory(sessionId: string): Promise<Message[]>
  latestTranscriptMtimeForWorktree(worktree: string): Promise<number>
}

export type EngineAccount = ClaudeAccount | CodexAccount | CopilotAccount

export interface EngineRegistryEntry {
  readonly vendor: VendorId
  readonly builtin: boolean
  readonly displayName: string
  readonly defaultCommand: readonly string[]
  readonly effortLevels?: readonly string[]
  readonly history: EngineHistoryReader
  readonly detectAccount: (deps?: DetectDeps) => Promise<EngineAccountStatus<EngineAccount>>
  readonly createHookAdapter: () => EngineHookAdapter
  readonly createTurnDetector: () => EngineTurnDetector
  readonly capabilities?: EngineCapabilities
  readonly identity?: EngineIdentity
}

export const EMPTY_HISTORY: EngineHistoryReader = {
  async listSessionIdsForWorktree() {
    return []
  },
  async readHistory() {
    return []
  },
  async latestTranscriptMtimeForWorktree() {
    return 0
  },
}

const claudeHistoryReader: EngineHistoryReader = {
  async listSessionIdsForWorktree(worktree) {
    const files = await claudeHistory.listSessionFilesForWorktree(worktree)
    return [...files].sort((a, b) => a.mtimeMs - b.mtimeMs).map((f) => f.sessionId)
  },
  readHistory: (sessionId) => claudeHistory.readHistory(sessionId),
  latestTranscriptMtimeForWorktree: (worktree) => claudeHistory.latestTranscriptMtimeForWorktree(worktree),
}

const codexHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => codexHistory.listSessionIdsForWorktree(worktree),
  readHistory: (sessionId) => codexHistory.readHistory(sessionId),
  latestTranscriptMtimeForWorktree: (worktree) => codexHistory.latestTranscriptMtimeForWorktree(worktree),
}

const copilotHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => copilotHistory.listSessionIdsForWorktree(worktree),
  readHistory: (sessionId) => copilotHistory.readHistory(sessionId),
  latestTranscriptMtimeForWorktree: (worktree) => copilotHistory.latestTranscriptMtimeForWorktree(worktree),
}

const BUILTIN_ENGINES: Record<"claude" | "codex" | "copilot", EngineRegistryEntry> = {
  claude: {
    vendor: "claude",
    builtin: true,
    displayName: "Claude",
    defaultCommand: ["claude"],
    history: claudeHistoryReader,
    detectAccount: (deps) => detectClaudeAccount(deps),
    createHookAdapter: () => new ClaudeHookAdapter(),
    createTurnDetector: () => new ClaudeTurnDetector(),
    capabilities: claudeCapabilities,
    identity: claudeIdentity,
  },
  codex: {
    vendor: "codex",
    builtin: true,
    displayName: "Codex",
    defaultCommand: ["codex"],
    effortLevels: ["none", "low", "medium", "high", "xhigh"],
    history: codexHistoryReader,

    detectAccount: (deps) => detectCodexAccount(deps),
    createHookAdapter: () => new CodexHookAdapter(),
    createTurnDetector: () => new CodexTurnDetector(),
    capabilities: codexCapabilities,
    identity: codexIdentity,
  },
  copilot: {
    vendor: "copilot",
    builtin: true,
    displayName: "Copilot",
    defaultCommand: ["copilot"],
    history: copilotHistoryReader,
    detectAccount: (deps) => detectCopilotAccount(deps),
    createHookAdapter: () => new NoopHookAdapter("copilot"),
    createTurnDetector: () => new UnknownTurnDetector("copilot"),
  },
}

function customEngineEntry(vendor: VendorId): EngineRegistryEntry {
  return {
    vendor,
    builtin: false,
    displayName: vendor,
    defaultCommand: [vendor],
    history: EMPTY_HISTORY,
    detectAccount: async () => ({
      binary: { found: false, error: "custom engine: kobe has no account detector for it" },
      account: { kind: "none" },
    }),
    createHookAdapter: () => new NoopHookAdapter(vendor),
    createTurnDetector: () => new UnknownTurnDetector(vendor),
  }
}

export function engineEntry(vendor: VendorId): EngineRegistryEntry {
  return isBuiltinVendor(vendor) ? BUILTIN_ENGINES[vendor] : customEngineEntry(vendor)
}

export function getCapabilities(vendor: VendorId): EngineCapabilities | undefined {
  return engineEntry(vendor).capabilities
}

export function allModels(): readonly EngineCapabilities["models"][number][] {
  const seen = new Set<string>()
  const out: EngineCapabilities["models"][number][] = []
  for (const entry of Object.values(BUILTIN_ENGINES)) {
    if (!entry.capabilities) continue
    for (const m of entry.capabilities.models) {
      const key = `${m.vendor}:${m.id}:${m.effort ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
  }
  return out
}
