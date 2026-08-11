/**
 * Fork-this-chat (`chat.tab.fork`): a new tab in the SAME worktree that
 * opens on the active tab's conversation and then diverges — the sibling of
 * `quick-fork.ts`, which forks the WORKTREE into a child task.
 *
 * Split out of `TerminalTabs.tsx` for the file-size cap; the vendor-specific
 * launch flags live in the engine layer (`forkSessionArgv`), the tab-state
 * transition in `terminal-tabs-core`, so this is just the join.
 */

import { canForkSession, engineDisplayName } from "@/engine/interactive-command"
import { engineEntry } from "@/engine/registry"
import { buildHandoffPrompt } from "@/engine/session-handoff"
import type { VendorId } from "@/types/vendor"
import {
  type TabsState,
  type TerminalTab,
  addTab,
  setTabForkFrom,
  setTabInitialPrompt,
} from "../../tui/workspace/terminal-tabs-core"

/** What the chord can actually do here — the caller notifies on the
 *  refusals instead of silently opening a blank tab (which is what a
 *  fork-less engine would otherwise get). */
export type ChatForkPlan =
  /** Same engine, native fork: it reopens its own conversation and branches. */
  | { readonly kind: "fork"; readonly sessionId: string }
  /** Different engine: it starts fresh, briefed to read the old transcript. */
  | { readonly kind: "handoff"; readonly prompt: string }
  /** Nothing to continue from — this tab has no conversation yet. */
  | { readonly kind: "no-session" }
  /** There IS a conversation, but its engine keeps no transcript kobe can
   *  name (kimi, copilot, custom), so there is nothing to hand over. */
  | { readonly kind: "no-transcript"; readonly engine: string }

/**
 * Resolve "continue this chat in `target`" to one outcome.
 *
 * Same engine that can branch → a real fork (both sides keep full context
 * natively). Anything else → a HANDOFF: the target engine starts a fresh
 * session briefed with the source transcript's path, the format-agnostic
 * approach Orca uses (see `session-handoff.ts`). No transcript conversion
 * is ever attempted.
 */
export async function planChatContinuation(
  active: TerminalTab,
  source: VendorId,
  target: VendorId,
  worktree: string,
): Promise<ChatForkPlan> {
  const sessionId = await forkSourceSessionId(active, source, worktree)
  if (!sessionId) return { kind: "no-session" }
  if (target === source && canForkSession(source)) return { kind: "fork", sessionId }
  const transcriptPath = await engineEntry(source).history.transcriptPath(sessionId, worktree)
  if (!transcriptPath) return { kind: "no-transcript", engine: engineDisplayName(source) }
  return {
    kind: "handoff",
    prompt: buildHandoffPrompt({ fromEngine: engineDisplayName(source), transcriptPath, worktree }),
  }
}

/**
 * "Continue this conversation" for the FORK destination (issue #7): the
 * child task runs in a NEW worktree, and engine-native session forks are
 * keyed to the source cwd — so this is ALWAYS a handoff (or a refusal),
 * never `{ kind: "fork" }`. The brief names the source worktree, which is
 * where the transcript's work actually happened.
 */
export async function planWorktreeHandoff(
  active: TerminalTab,
  source: VendorId,
  worktree: string,
): Promise<ChatForkPlan> {
  const sessionId = await forkSourceSessionId(active, source, worktree)
  if (!sessionId) return { kind: "no-session" }
  const transcriptPath = await engineEntry(source).history.transcriptPath(sessionId, worktree)
  if (!transcriptPath) return { kind: "no-transcript", engine: engineDisplayName(source) }
  return {
    kind: "handoff",
    prompt: buildHandoffPrompt({ fromEngine: engineDisplayName(source), transcriptPath, worktree }),
  }
}

/**
 * Session id the fork should open on: the tab's OWN pinned id when it has
 * one (claude tabs kobe launched itself), else the newest session the
 * engine recorded for this worktree — codex tabs and pre-`--session-id`
 * rehydrated tabs have no pin, and the engine's own transcript store is the
 * only source of truth for what conversation this tab is showing.
 * `listSessionIdsForWorktree` is oldest-first, so the fork source is last.
 */
export async function forkSourceSessionId(
  active: TerminalTab,
  vendor: VendorId,
  worktree: string,
): Promise<string | null> {
  if (active.kind !== "engine") return null
  if (active.sessionId) return active.sessionId
  const ids = await engineEntry(vendor).history.listSessionIdsForWorktree(worktree)
  return ids.at(-1) ?? null
}

/** New engine tab pinned to `vendor` (always CONCRETE — `engineTabArgv`
 *  only forks a tab whose vendor it can read), marked as its fork. */
export function addForkTab(state: TabsState, vendor: VendorId, sourceSessionId: string): TabsState {
  const next = addTab(state, vendor)
  return setTabForkFrom(next, next.activeId, sourceSessionId)
}

/** New engine tab pinned to `vendor`, opening on the handoff brief. */
export function addHandoffTab(state: TabsState, vendor: VendorId, prompt: string): TabsState {
  const next = addTab(state, vendor)
  return setTabInitialPrompt(next, next.activeId, prompt)
}
