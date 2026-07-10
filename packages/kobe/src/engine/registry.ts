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
import { CLAUDE_SPINNER_FRAMES } from "./spinner-frames.ts"
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
  /**
   * Newest transcript mtime (epoch ms) for `worktree`, or 0 when the task
   * has no transcript yet. The Ops pane's activity poll watches this to
   * light its "new activity" badge. Never throws — readers are
   * best-effort and the poller treats 0 as "no activity seen".
   */
  latestTranscriptMtimeForWorktree(worktree: string): Promise<number>
}

/** Any built-in engine's account shape (each union already has a `none` arm). */
export type EngineAccount = ClaudeAccount | CodexAccount | CopilotAccount

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
  latestTranscriptMtimeForWorktree: (worktree) => claudeHistory.latestTranscriptMtimeForWorktree(worktree),
}

/** Codex's reader — `listSessionIdsForWorktree` is already oldest-first. */
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

/** The three first-party entries — registered here and nowhere else. */
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
    spinnerFrames: CLAUDE_SPINNER_FRAMES,
    terminalTitle: { ownsStatus: true },
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
 * Match a live terminal window title (OSC 0/2 — `TaskPtyLike.onTitleChange`)
 * to the engine whose CLI set it. This is how a shell tab where the USER
 * typed `claude` joins the same turn-status management as a kobe-launched
 * engine tab (owner model 2026-07-07: every tab is a shell; an engine is
 * just a process running in it). Two engine-owned signals, checked per
 * built-in entry so neutral layers never hard-code vendor strings:
 *   - the product name anywhere in the title  (claude sets "✳ Claude Code")
 *   - the launch binary as a whole word       (zsh-preexec-style "claude")
 * Custom engines aren't matched — kobe knows nothing about their titles.
 */
export function vendorFromTerminalTitle(title: string | null | undefined): VendorId | null {
  if (!title) return null
  const lower = title.toLowerCase()
  for (const entry of Object.values(BUILTIN_ENGINES)) {
    if (entry.identity && lower.includes(entry.identity.productName.toLowerCase())) return entry.vendor
    const bin = entry.defaultCommand[0]?.toLowerCase()
    if (bin && new RegExp(`(^|\\s)${bin}(\\s|$)`).test(lower)) return entry.vendor
  }
  return null
}

/**
 * Display name for a live terminal title: an engine's own title collapses
 * to its launch binary ("✳ Claude Code" → "claude", codex's likewise) so
 * every kobe surface (tab labels, split corner tags) speaks ONE vocabulary
 * for a process no matter how it was started or what decoration the CLI
 * put in its title. Non-engine titles pass through raw (vim, htop, a
 * cwd-titling shell) — that's the dynamic real-terminal behavior.
 */
export function titleDisplayName(title: string): string {
  const vendor = vendorFromTerminalTitle(title)
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
