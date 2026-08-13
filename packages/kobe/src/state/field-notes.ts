/**
 * Read side of the durable field-note store (docs/design/dispatcher.md).
 * The DAEMON is the only writer (`kobe-daemon/src/daemon/notes-store.ts`);
 * this module is the launch path's reader, so a fresh worktree session can be
 * born knowing what previous sessions on the repo already paid to learn.
 *
 * Sync on purpose: `buildEngineSessionLaunch` is synchronous, and this is the
 * same shape as `repo-init.ts` reading `.rove/init-prompt.md` off disk at
 * launch. A missing/corrupt store is simply "no notes" — a knowledge feature
 * must never be able to block a session from starting.
 *
 * Matching is by `repoRoot`, not by re-deriving the store's git-common-dir
 * key: the daemon writes each record's `repoRoot` as the repo's main
 * worktree, and a task's `repo` field is already that same source root.
 */

import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { roveStateDir } from "../env.ts"

/** How many of the newest notes a fresh session is seeded with. */
export const NOTE_INJECTION_CAP = 15

export interface StoredFieldNote {
  readonly at: string
  readonly text: string
  readonly taskId: string
  readonly author: string
}

export function fieldNotesPath(): string {
  return join(roveStateDir(), "notes.json")
}

/** Resolve symlinks so `/var` vs `/private/var` can't split one repo in two. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Newest-first notes for `repoRoot`, capped at {@link NOTE_INJECTION_CAP}.
 * Empty for an unknown repo, an absent store, or anything unreadable.
 */
export function readFieldNotes(repoRoot: string, path = fieldNotesPath()): readonly StoredFieldNote[] {
  if (!repoRoot) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return []
  }
  const repos = (parsed as { repos?: Record<string, unknown> } | null)?.repos
  if (!repos || typeof repos !== "object") return []
  const target = canonical(repoRoot)
  for (const record of Object.values(repos)) {
    if (!record || typeof record !== "object") continue
    const typed = record as { repoRoot?: unknown; notes?: unknown }
    if (typeof typed.repoRoot !== "string" || canonical(typed.repoRoot) !== target) continue
    if (!Array.isArray(typed.notes)) return []
    return typed.notes
      .filter(
        (n): n is StoredFieldNote => !!n && typeof n === "object" && typeof (n as StoredFieldNote).text === "string",
      )
      .slice(0, NOTE_INJECTION_CAP)
  }
  return []
}
