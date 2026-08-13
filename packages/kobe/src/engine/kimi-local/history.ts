/**
 * Kimi Code's transcript store — PATHS ONLY, no message parsing.
 *
 * The wire format (`agents/<agent>/wire.jsonl`, a protocol stream rather
 * than a message log) is still unverified against a real conversation, so
 * Rove does not parse it: `readHistory` stays empty and auto-title keeps
 * the placeholder rather than guessing. What IS verified (live install,
 * 2026-08-13) is the layout, and that is all a cross-engine handoff needs
 * — it hands the next agent the transcript's PATH and lets it read the
 * file in whatever format it finds (see `session-handoff.ts`).
 *
 *   ~/.kimi-code/session_index.jsonl   one line per session:
 *                                      {sessionId, sessionDir, workDir}
 *   <sessionDir>/agents/main/wire.jsonl   the main agent's stream
 *                                         (sub-agents get their own dirs)
 *
 * The index is the worktree map — `workDir` is the cwd kimi was launched
 * in, matched against the task's worktree exactly like copilot's
 * `workspace.yaml` `cwd`.
 */

import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { readTextFileBounded } from "../file-bounds"

export interface KimiHistoryDeps {
  kimiDir(): string
  readFile(p: string): Promise<string>
  stat(p: string): Promise<{ mtimeMs: number }>
}

const defaultDeps: KimiHistoryDeps = {
  kimiDir() {
    const override = process.env.KIMI_CODE_HOME?.trim()
    return override || path.join(homedir(), ".kimi-code")
  },
  async readFile(p) {
    // Size-bounded like the other readers: a corrupt index degrades to ""
    // rather than slurping an unbounded file.
    return await readTextFileBounded(p)
  },
  stat,
}

export interface KimiSessionEntry {
  readonly sessionId: string
  readonly sessionDir: string
  readonly workDir: string
}

/** Parse `session_index.jsonl`, skipping malformed or incomplete lines. */
export function parseSessionIndex(raw: string): KimiSessionEntry[] {
  const out: KimiSessionEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const { sessionId, sessionDir, workDir } = JSON.parse(line) as Partial<KimiSessionEntry>
      if (sessionId && sessionDir && workDir) out.push({ sessionId, sessionDir, workDir })
    } catch {
      // partial line from a concurrent append — skip
    }
  }
  return out
}

async function sessionIndex(deps: KimiHistoryDeps): Promise<KimiSessionEntry[]> {
  const raw = await deps.readFile(path.join(deps.kimiDir(), "session_index.jsonl")).catch(() => "")
  return parseSessionIndex(raw)
}

/** The main agent's stream — the one a handoff points at. Sub-agent dirs
 *  (`agents/agent-N/`) are that session's internal fan-out, not its
 *  conversation. */
export function wirePath(sessionDir: string): string {
  return path.join(sessionDir, "agents", "main", "wire.jsonl")
}

/**
 * Session ids rooted at `worktree`, OLDEST-FIRST per the registry
 * contract. Ordered by `wire.jsonl` mtime (last activity) rather than the
 * index's append order, so `.at(-1)` — what the handoff forks from — is the
 * conversation actually worked in most recently, not merely created last.
 * Sessions whose stream is missing are dropped: nothing to hand over.
 */
export async function listSessionIdsForWorktree(
  worktree: string,
  deps: KimiHistoryDeps = defaultDeps,
): Promise<string[]> {
  if (!worktree) return []
  const matches: { id: string; mtimeMs: number }[] = []
  for (const entry of await sessionIndex(deps)) {
    if (entry.workDir !== worktree) continue
    const mtimeMs = await deps
      .stat(wirePath(entry.sessionDir))
      .then((s) => s.mtimeMs)
      .catch(() => null)
    if (mtimeMs === null) continue
    matches.push({ id: entry.sessionId, mtimeMs })
  }
  return matches.sort((a, b) => a.mtimeMs - b.mtimeMs).map((m) => m.id)
}

/** mtime (epoch ms) of a stream this module resolved, or 0 when it went
 *  away between the resolve and the stat. */
export async function transcriptMtime(file: string, deps: KimiHistoryDeps = defaultDeps): Promise<number> {
  return await deps
    .stat(file)
    .then((s) => s.mtimeMs)
    .catch(() => 0)
}

/** Absolute path of `sessionId`'s stream, or null when the index has no
 *  such id / the file isn't on disk (a handoff must not brief the next
 *  agent with a path that doesn't resolve). */
export async function transcriptPath(sessionId: string, deps: KimiHistoryDeps = defaultDeps): Promise<string | null> {
  if (!sessionId) return null
  const entry = (await sessionIndex(deps)).find((e) => e.sessionId === sessionId)
  if (!entry) return null
  const file = wirePath(entry.sessionDir)
  return await deps
    .stat(file)
    .then(() => file)
    .catch(() => null)
}
