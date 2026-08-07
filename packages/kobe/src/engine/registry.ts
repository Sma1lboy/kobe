/**
 * Engine registry — the ONE place per-vendor wiring lives.
 *
 * CLAUDE.md "Engine-owned UI data": neutral layers (monitor, orchestrator,
 * TUI) must not hard-code vendor strings or pick vendor-specific readers
 * with inline if-ladders. Instead they call {@link engineEntry} with the
 * task's `vendor` and use whatever the entry exposes:
 *
 *   - `history`        — transcript store reader (auto-title, recap).
 *   - `detectAccount`  — read-only login/binary probe (Settings → Accounts).
 *   - `createHookAdapter` — activity-hook installer (claude + codex today).
 *   - `createTurnDetector` — ChatTab turn-completion detection.
 *   - `defaultCommand` / `displayName` — launch + label defaults.
 *
 * Adding an engine = one new entry here (plus its vendor-local modules);
 * removing the vendor if-ladders from neutral code was the point (KOB).
 *
 * Custom (user-registered) engines get {@link customEngineEntry}: an
 * explicit, documented EMPTY entry — no transcript store (auto-title keeps
 * the placeholder rather than mis-reading another vendor's files), no
 * account detection, no hooks, and a `defaultCommand` of the
 * bare id (the real launch command lives in the user's
 * `engineCommand.<id>` override; see `interactive-command.ts`). This
 * preserves the pre-registry behavior for unknown vendor ids exactly.
 *
 * Must stay importable from vitest and MUST NOT import from `src/tui/`.
 */

import type { EngineCapabilities, EngineIdentity, EngineQuotaUsage, EngineTrace, Message } from "@/types/engine"
import { type VendorId, isBuiltinVendor } from "@/types/vendor"
import {
  type ClaudeAccount,
  type CodexAccount,
  type CopilotAccount,
  type DetectDeps,
  type EngineAccountStatus,
  type KimiAccount,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
  detectKimiAccount,
} from "./account-detect.ts"
import { claudeCapabilities, claudeIdentity } from "./claude-code-local/capabilities.ts"
import * as claudeHistory from "./claude-code-local/history.ts"
import { ClaudeHookAdapter } from "./claude-code-local/hook-adapter.ts"
import { fetchClaudeQuotaUsage } from "./claude-code-local/quota.ts"
import { codexCapabilities, codexIdentity } from "./codex-local/capabilities.ts"
import * as codexHistory from "./codex-local/history.ts"
import { CodexHookAdapter } from "./codex-local/hook-adapter.ts"
import { type EngineSessionActivation, observeCodexSessionActivation } from "./codex-local/session-activation.ts"
import * as copilotHistory from "./copilot-local/history.ts"
import { type EngineHookAdapter, NoopHookAdapter } from "./hook-adapter.ts"
import { CLAUDE_SPINNER_FRAMES } from "./spinner-frames.ts"
import { traceFromHistory } from "./trace-from-history.ts"
import { ClaudeTurnDetector, CodexTurnDetector, type EngineTurnDetector, UnknownTurnDetector } from "./turn-detector.ts"

/**
 * Reader over an engine's on-disk transcript store, in the neutral shape
 * auto-title (and future recap) consumes. Vendor formats stay behind it:
 * claude's per-worktree `~/.claude/projects/*` dirs, codex's global
 * `~/.codex/sessions/**` rollouts, copilot's `~/.copilot/session-state`.
 */
export interface EngineHistoryReader {
  /**
   * Session ids recorded for `worktree`, OLDEST-FIRST (the task's origin
   * conversation comes first — auto-title depends on this order). `[]`
   * when the worktree has no transcripts. Never throws.
   */
  listSessionIdsForWorktree(worktree: string): Promise<readonly string[]>
  /** Neutral messages for one session id; `[]` when not found. */
  readHistory(sessionId: string): Promise<Message[]>
  /** Engine-normalized execution trace for GUI consumers. */
  readTrace?(sessionId: string): Promise<EngineTrace>
  /** Monotonic-enough persisted trace revision (normally transcript mtime).
   * Consumers use it only as an invalidation token and always refetch a full
   * trace snapshot, so daemon/browser reconnects need no delta replay. */
  traceRevision?(sessionId: string): Promise<number>
  /**
   * Absolute path of the on-disk transcript for `sessionId`, or null when
   * the engine has no file to point at. Not for kobe to PARSE (that's
   * `readHistory`) — it is what the cross-engine handoff hands the next
   * agent to read itself, so its native format never has to be converted.
   * `worktree` scopes stores that key by directory (claude's project dir).
   */
  transcriptPath(sessionId: string, worktree: string): Promise<string | null>
  /** Session whose transcript has the newest activity for this worktree. */
  latestSessionForWorktree?(worktree: string): Promise<{ sessionId: string; transcriptPath?: string } | null>
  /**
   * Newest transcript mtime (epoch ms) for `worktree`, or 0 when the task
   * has no transcript yet. The Ops pane's activity poll watches this to
   * light its "new activity" badge. Never throws — readers are
   * best-effort and the poller treats 0 as "no activity seen".
   */
  latestTranscriptMtimeForWorktree(worktree: string): Promise<number>
}

/** Any built-in engine's account shape (each union already has a `none` arm). */
export type EngineAccount = ClaudeAccount | CodexAccount | CopilotAccount | KimiAccount

export interface EngineRegistryEntry {
  readonly vendor: VendorId
  /** True for the three first-party engines; false for user-added ids. */
  readonly builtin: boolean
  /** Built-in human label ("Claude"); a custom engine labels as its id. */
  readonly displayName: string
  /**
   * Built-in launch argv before any user `engineCommand.<id>` override.
   * Custom engines fall back to a bare binary named after the id.
   */
  readonly defaultCommand: readonly string[]
  /**
   * Reasoning/effort levels this engine accepts, lowest→highest. Codex maps
   * a selected level to `-c model_reasoning_effort=<level>` at launch (see
   * `interactive-command.ts`). Undefined for engines with no kobe-driveable
   * effort flag (claude picks reasoning at runtime; copilot/custom have none).
   */
  readonly effortLevels?: readonly string[]
  /** Transcript store reader. Empty (not claude's!) for custom engines. */
  readonly history: EngineHistoryReader
  /**
   * Optional engine-owned observer for native context switches that happen
   * before the provider emits its ordinary lifecycle hook.
   */
  readonly observeSessionActivation?: (input: {
    readonly rootPid: number
    readonly afterMs: number
  }) => Promise<EngineSessionActivation | null>
  /**
   * Read-only binary + login probe (Settings → Accounts). `deps` is the
   * injectable fs/env surface from `account-detect.ts`; omit for production.
   */
  readonly detectAccount: (deps?: DetectDeps) => Promise<EngineAccountStatus<EngineAccount>>
  /** Activity-hook adapter — a no-op adapter for engines without wired hooks. */
  readonly createHookAdapter: () => EngineHookAdapter
  /**
   * Turn-completion detector for ChatTab status (transcript markers +
   * pane quiescence; see `turn-detector.ts`). Engines without persisted
   * completion markers (copilot, custom) get an {@link UnknownTurnDetector}
   * whose `supportsCompletionMarkers()` is false.
   */
  readonly createTurnDetector: () => EngineTurnDetector
  /**
   * Model catalog + permission modes + identity (settings, pickers).
   * Undefined for engines without a kobe-known catalog (copilot, custom).
   */
  readonly capabilities?: EngineCapabilities
  /** Product identity (composer placeholder etc.). Paired with capabilities. */
  readonly identity?: EngineIdentity
  /**
   * Brand spinner frame set for this engine's running rows (sidebar badge).
   * Omit for engines without one — consumers fall back to the neutral
   * braille set (`spinner-frames.ts` `DEFAULT_SPINNER_FRAMES`).
   */
  readonly spinnerFrames?: readonly string[]
  /**
   * Native OSC 0/2 title policy for interactive terminal sessions.
   * `ownsStatus` means the engine's live title is the status surface while
   * it is visible, so neutral tab chrome must not prefix a duplicate turn
   * glyph. `launchArgs` lets an adapter select the engine's own title fields
   * without teaching the launcher vendor-specific config syntax.
   */
  readonly terminalTitle?: {
    readonly ownsStatus: boolean
    readonly launchArgs?: readonly string[]
  }
  /**
   * Subscription-quota probe: snapshot of the account's usage windows, or
   * null when unknowable. Drives the daemon's rate-limit auto-resume
   * schedule and the Settings usage dashboard. The probe hits the vendor's
   * own rate-limited API — the daemon's usage cache owns the fetch cadence;
   * never call this per-render or per-event. Omit for engines without a
   * readable quota API.
   */
  readonly quotaUsage?: () => Promise<EngineQuotaUsage | null>
}

/**
 * The documented empty history reader for engines with no on-disk
 * transcript store (custom engines). Auto-title then keeps the placeholder
 * title rather than mis-reading claude's transcripts (the old
 * `else → claude` default would do exactly that for any unknown id).
 */
export const EMPTY_HISTORY: EngineHistoryReader = {
  async listSessionIdsForWorktree() {
    return []
  },
  async readHistory() {
    return []
  },
  async transcriptPath() {
    return null
  },
  async latestSessionForWorktree() {
    return null
  },
  // No transcript store → no activity signal (the Ops badge stays dark
  // rather than mis-watching another vendor's files).
  async latestTranscriptMtimeForWorktree() {
    return 0
  },
}

/**
 * Claude's reader. `listSessionFilesForWorktree` sorts NEWEST-first (the
 * activity callers want that); the registry contract is oldest-first,
 * so re-sort ascending by mtime here — exactly what auto-title did inline.
 */
const claudeHistoryReader: EngineHistoryReader = {
  async listSessionIdsForWorktree(worktree) {
    const files = await claudeHistory.listSessionFilesForWorktree(worktree)
    return [...files].sort((a, b) => a.mtimeMs - b.mtimeMs).map((f) => f.sessionId)
  },
  readHistory: (sessionId) => claudeHistory.readHistory(sessionId),
  async readTrace(sessionId) {
    return traceFromHistory(sessionId, await claudeHistory.readHistory(sessionId))
  },
  async transcriptPath(sessionId, worktree) {
    const files = await claudeHistory.listSessionFilesForWorktree(worktree)
    return files.find((f) => f.sessionId === sessionId)?.path ?? null
  },
  async latestSessionForWorktree(worktree) {
    const file = (await claudeHistory.listSessionFilesForWorktree(worktree))[0]
    return file ? { sessionId: file.sessionId, transcriptPath: file.path } : null
  },
  latestTranscriptMtimeForWorktree: (worktree) => claudeHistory.latestTranscriptMtimeForWorktree(worktree),
}

/** Codex's reader — `listSessionIdsForWorktree` is already oldest-first. */
const codexHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => codexHistory.listSessionIdsForWorktree(worktree),
  readHistory: (sessionId) => codexHistory.readHistory(sessionId),
  readTrace: (sessionId) => codexHistory.readTrace(sessionId),
  traceRevision: (sessionId) => codexHistory.traceRevision(sessionId),
  // The rollout filename embeds the UUID; the store is date-keyed, not
  // worktree-keyed, so the worktree argument is unused here.
  transcriptPath: async (sessionId) => (await codexHistory.findRolloutFile(sessionId)) ?? null,
  async latestSessionForWorktree(worktree) {
    const latest = await codexHistory.findLatestRolloutForWorktree(worktree)
    const sessionId = latest ? codexHistory.rolloutSessionId(latest.path) : null
    return latest && sessionId ? { sessionId, transcriptPath: latest.path } : null
  },
  latestTranscriptMtimeForWorktree: (worktree) => codexHistory.latestTranscriptMtimeForWorktree(worktree),
}

const copilotHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => copilotHistory.listSessionIdsForWorktree(worktree),
  readHistory: (sessionId) => copilotHistory.readHistory(sessionId),
  async readTrace(sessionId) {
    return traceFromHistory(sessionId, await copilotHistory.readHistory(sessionId))
  },
  // Copilot's store layout isn't mapped to a per-session file kobe can name.
  transcriptPath: async () => null,
  async latestSessionForWorktree(worktree) {
    const sessionId = (await copilotHistory.listSessionIdsForWorktree(worktree)).at(-1)
    return sessionId ? { sessionId } : null
  },
  latestTranscriptMtimeForWorktree: (worktree) => copilotHistory.latestTranscriptMtimeForWorktree(worktree),
}

/** The first-party entries — registered here and nowhere else. */
const BUILTIN_ENGINES: Record<"claude" | "codex" | "copilot" | "kimi", EngineRegistryEntry> = {
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
    spinnerFrames: CLAUDE_SPINNER_FRAMES,
    terminalTitle: { ownsStatus: true },
    quotaUsage: () => fetchClaudeQuotaUsage(),
  },
  codex: {
    vendor: "codex",
    builtin: true,
    displayName: "Codex",
    defaultCommand: ["codex"],
    // Effort levels real `codex exec` accepts (the broken `minimal` is
    // deliberately excluded — CHANGELOG 0.5.17).
    effortLevels: ["none", "low", "medium", "high", "xhigh"],
    history: codexHistoryReader,
    observeSessionActivation: observeCodexSessionActivation,

    detectAccount: (deps) => detectCodexAccount(deps),
    createHookAdapter: () => new CodexHookAdapter(),
    createTurnDetector: () => new CodexTurnDetector(),
    capabilities: codexCapabilities,
    identity: codexIdentity,
    // Codex's default is activity + project-name, which makes every tab in
    // one repo say "kobe". Keep its native activity state, but ask Codex to
    // pair it with the thread title it already owns in its local store.
    terminalTitle: {
      ownsStatus: true,
      launchArgs: ["-c", 'tui.terminal_title=["activity","thread-title"]'],
    },
  },
  copilot: {
    vendor: "copilot",
    builtin: true,
    displayName: "Copilot",
    defaultCommand: ["copilot"],
    history: copilotHistoryReader,
    detectAccount: (deps) => detectCopilotAccount(deps),
    createHookAdapter: () => new NoopHookAdapter("copilot"),
    // Copilot persists no turn-completion marker kobe can read yet.
    createTurnDetector: () => new UnknownTurnDetector("copilot"),
  },
  kimi: {
    vendor: "kimi",
    builtin: true,
    displayName: "Kimi",
    defaultCommand: ["kimi"],
    // Kimi persists sessions under ~/.kimi-code/sessions/wd_*/session_*/
    // (wire.jsonl protocol stream) but the message-record shape is
    // unverified against a real conversation, so no history reader yet —
    // EMPTY_HISTORY keeps auto-title/recap honest instead of mis-parsing.
    history: EMPTY_HISTORY,
    detectAccount: (deps) => detectKimiAccount(deps),
    createHookAdapter: () => new NoopHookAdapter("kimi"),
    createTurnDetector: () => new UnknownTurnDetector("kimi"),
  },
}

/** See module doc: the explicit empty entry for a user-registered engine id. */
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

/**
 * Resolve the registry entry for a vendor id. Built-ins return their
 * shared singleton entry; any other id returns a fresh
 * {@link customEngineEntry} (no registration step needed — a custom id is
 * "registered" by existing in the user's `customEngineIds` state, which
 * this module deliberately does not read so it stays state-free).
 */
export function engineEntry(vendor: VendorId): EngineRegistryEntry {
  return isBuiltinVendor(vendor) ? BUILTIN_ENGINES[vendor] : customEngineEntry(vendor)
}

/**
 * True when `vendor`'s adapter ships a REAL transcript-store reader —
 * i.e. its `history` is not the documented {@link EMPTY_HISTORY} sentinel.
 * Neutral layers (e.g. `kobe api read-output`) use this to label an
 * `engine_unsupported` fallback honestly instead of confusing "engine has
 * no reader" with "reader found no sessions". Lives here so the sentinel
 * comparison stays inside the engine-owned module.
 */
export function supportsStructuredHistory(vendor: VendorId): boolean {
  return engineEntry(vendor).history !== EMPTY_HISTORY
}

/*
 * `vendorFromTerminalTitle` lived here (removed 2026-07-27). It matched a
 * live OSC title against each engine's product name / binary by substring,
 * which is how a shell tab where the user typed `claude` joined turn-status
 * management — and also how a claude session whose activity summary said
 * "codex" became a codex tab. Identity now comes from the process tree:
 * `engine/foreground.ts` + `tui/workspace/live-engine.ts`.
 */

/**
 * Display name for a live terminal title: an engine's own title collapses
 * to its launch binary ("✳ Claude Code" → "claude", codex's likewise) so
 * every kobe surface (tab labels, split corner tags) speaks ONE vocabulary
 * for a process no matter how it was started or what decoration the CLI
 * put in its title. Non-engine titles pass through raw (vim, htop, a
 * cwd-titling shell) — that's the dynamic real-terminal behavior.
 *
 * `vendor` is the PROCESS identity (`live-engine.ts`), not something read
 * back out of the title: deriving it from the title itself is what
 * labelled a claude tab "codex" whenever claude's activity summary
 * mentioned codex.
 */
export function titleDisplayName(title: string, vendor: VendorId | null): string {
  return vendor ? (engineEntry(vendor).defaultCommand[0] ?? vendor) : title
}

/**
 * Capabilities for a vendor, or `undefined` when the engine has none (copilot,
 * custom). Consumed by the native chat composer's model picker +
 * permission-mode cycle; callers must handle the missing case rather than
 * borrow another vendor's catalog + permission modes.
 */
export function getCapabilities(vendor: VendorId): EngineCapabilities | undefined {
  return engineEntry(vendor).capabilities
}

/** Flat de-duped list of every model surfaced by every registered vendor. */
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
