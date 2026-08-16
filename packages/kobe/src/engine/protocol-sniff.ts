/**
 * Tier (b) of protocol resolution: name the engine behind a session whose
 * LAUNCH COMMAND could not be named (see `engine-presets.ts` for the tiers).
 *
 * A raw `--command` may be a wrapper, an alias, or a script — argv[0] says
 * nothing. But a running engine leaves two fingerprints that no neutral
 * layer has to hard-code:
 *
 *   - its OSC title's STATUS GLYPH. Engines that own their title write a
 *     declared vocabulary into it (`terminalTitle.statusPrefixes`, claude's
 *     ✳/⠂, codex's braille frames). The daemon's title pipeline already
 *     reads that vocabulary FORWARD (`engineTitleTurnHint(vendor, title)`
 *     asks "is this vendor working?"); this is the same table read
 *     BACKWARD — "which vendor writes a glyph like this?".
 *   - a SESSION FILE appearing under the task's worktree. Every built-in
 *     keys its transcript store by cwd or records the cwd in the rollout,
 *     which is exactly what `EngineHistoryReader.listSessionIdsForWorktree`
 *     resolves. A store that answers for this worktree is the engine that
 *     wrote it.
 *
 * Both are evidence, never a default: nothing recognisable answers `null`
 * and the caller stays on the generic protocol. The glyph read is
 * deliberately conservative — a glyph shared by several vendors identifies
 * none of them, because a wrong protocol is worse than no protocol (it
 * points the history reader and the trust store at another vendor's files).
 * Today's built-in vocabularies are disjoint (claude's ✳/⠂/⠐/◐/◑ vs codex's
 * ten braille frames), so that rule costs nothing now and is what keeps a
 * future engine borrowing a glyph from silently stealing its identity.
 *
 * NOTHING CONSUMES THIS YET — issue #31 owns wiring it into the record
 * upgrade (a task that resolved to the generic protocol, whose live session
 * turns out to be a known engine, should have its protocol corrected). Both
 * reads are pure so the consumer can be added without touching them.
 */

import { BUILTIN_VENDORS, type VendorId } from "@/types/vendor"
import { engineEntry } from "./registry.ts"

/**
 * The vendor whose status vocabulary this live title starts with, or null.
 * Only glyphs UNIQUE to one vendor identify: codex and claude share braille
 * frames, so a `⠹` prefix is evidence of "some engine", not of codex.
 */
export function sniffProtocolFromTitle(title: string | null | undefined): VendorId | null {
  const trimmed = title?.trim()
  if (!trimmed) return null
  const owners = new Map<string, VendorId[]>()
  for (const vendor of BUILTIN_VENDORS) {
    for (const glyph of engineEntry(vendor).terminalTitle?.statusPrefixes ?? []) {
      owners.set(glyph, [...(owners.get(glyph) ?? []), vendor])
    }
  }
  // Longest glyph first, mirroring `stripEngineStatusPrefix`'s rule so a
  // multi-char prefix is never shadowed by a shorter one.
  for (const glyph of [...owners.keys()].sort((a, b) => b.length - a.length)) {
    if (!trimmed.startsWith(glyph)) continue
    // A title that is ONLY the glyph is a name, not a status (same
    // conservatism as the strip path).
    if (trimmed.slice(glyph.length).trim().length === 0) continue
    const vendors = owners.get(glyph) ?? []
    if (vendors.length === 1) return vendors[0]
    return null // ambiguous vocabulary — no verdict
  }
  return null
}

/**
 * The vendor whose transcript store has sessions for `worktree`, or null.
 * Best-effort by contract (readers never throw); a worktree several engines
 * have touched answers null rather than picking one.
 */
export async function sniffProtocolFromSessions(worktree: string | undefined): Promise<VendorId | null> {
  if (!worktree) return null
  const found: VendorId[] = []
  for (const vendor of BUILTIN_VENDORS) {
    try {
      const ids = await engineEntry(vendor).history.listSessionIdsForWorktree(worktree)
      if (ids.length > 0) found.push(vendor)
    } catch {
      /* a store that cannot be read is not evidence */
    }
  }
  return found.length === 1 ? found[0] : null
}

/**
 * Combined sniff: the title first (it answers instantly and describes the
 * process that is running RIGHT NOW), then the session store (slower, and a
 * file can outlive the engine that wrote it). Null = stay generic.
 */
export async function sniffProtocol(input: {
  readonly title?: string | null
  readonly worktree?: string
}): Promise<VendorId | null> {
  return sniffProtocolFromTitle(input.title) ?? (await sniffProtocolFromSessions(input.worktree))
}
