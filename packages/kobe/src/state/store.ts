/**
 * Single owner of `~/.config/kobe/state.json` I/O.
 *
 * This file exists to kill a dual-writer hazard: with several kobe
 * processes alive at once, any writer that flushes a whole in-memory
 * snapshot clobbers keys another process wrote since that snapshot was
 * taken (the classic lost update). Every write therefore goes through
 * the read-merge-write transaction here.
 *
 * The fix is read-merge-write: every write re-reads the file fresh and
 * applies ONLY the keys the caller actually changed, then writes the
 * merged result atomically (tmp + rename, same crash-safety as before).
 * Concurrent writers touching DIFFERENT keys can no longer erase each
 * other; same-key writers remain last-write-wins, which is the documented
 * pre-existing semantics. There is still no flock — the merge shrinks the
 * race window to the read→rename span of a sync call, it does not
 * serialize writers. A true cross-process lock is the multi-instance
 * follow-up if same-key contention ever becomes real.
 *
 * Corrupt-file policy (aligned with orchestrator/index/store.ts's tasks.json
 * handling): a missing state.json reads as `{}` silently — that's the normal
 * fresh-machine case. Unparseable JSON is different: the bad file is renamed
 * to `state.json.corrupt-<ts>` (never deleted — a forensic copy survives) and
 * a warning goes to stderr once, then `{}` is returned so the UI/CLI is never
 * blocked. Either way the caller always gets `{}`, never a throw.
 *
 * tmp-write uniqueness: `writeStateFile` targets `${path}.<pid>.<nonce>.tmp`,
 * not a fixed shared name. Every write here still goes through the
 * read-merge-write of `patchStateFile`/`updateStateFile` above, but nothing
 * stops two DIFFERENT processes from calling `writeStateFile` at genuinely
 * the same instant (no flock, per the module's opening paragraph) — a shared
 * tmp path would let one process's `writeFileSync` interleave with another's
 * on the same inode and rename over a torn write. Per-process-unique tmp
 * names make that impossible; the final `rename()` stays atomic and
 * last-write-wins, unchanged.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kvStatePath } from "../env.ts"

let corruptWarned = false

/** The flat JSON object persisted at `kvStatePath()`. */
export type StateSnapshot = Record<string, unknown>

/**
 * Read + parse the state file. Returns `{}` for a missing file, malformed
 * JSON, or a non-object root (array/string/number) — see the corrupt-file
 * policy in the module doc. Never throws.
 */
export function loadStateFile(): StateSnapshot {
  const path = kvStatePath()
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    // Missing (or unreadable) file: normal fresh-machine case, start fresh.
    return {}
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StateSnapshot
    }
  } catch {
    // fall through to the corrupt-JSON handling below
  }
  // The file exists but didn't parse as a JSON object: back it up instead of
  // silently discarding it, then start fresh. Best-effort — if the backup
  // rename itself fails (e.g. file vanished between read and rename), we
  // still must not throw or block the caller.
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
    if (!corruptWarned) {
      corruptWarned = true
      console.error(`[kobe] ${path} is corrupted; backed up and starting fresh.`)
    }
  } catch {
    // Nothing more we can do; still return {} below.
  }
  return {}
}

/**
 * Atomic whole-file write: serialize to a process-unique
 * `state.json.<pid>.<nonce>.tmp`, then rename over `state.json` so a crash
 * mid-write can never leave a half-written file. The tmp name is unique per
 * call (not just per process) so two writes racing in the same process via
 * concurrent callers can't collide either. `undefined` values vanish at
 * JSON.stringify time, which is how key deletion serializes. Throws on I/O
 * failure — callers decide whether that's fatal (CLI) or logged-and-retried
 * (KVProvider's next flush).
 */
function writeStateFile(state: StateSnapshot): void {
  const path = kvStatePath()
  mkdirSync(dirname(path), { recursive: true })
  const nonce = Math.random().toString(36).slice(2)
  const tmp = `${path}.${process.pid}.${nonce}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
  renameSync(tmp, path)
}

/**
 * Single read-merge-write transaction: re-read the file FRESH, hand the
 * snapshot to `mutate`, write the result atomically. The fresh read is the
 * whole point — basing the write on the on-disk state of *now* (not a
 * snapshot this process took earlier) is what stops one writer from
 * resurrecting/erasing keys another process changed in the meantime.
 *
 * `mutate` may return `false` to skip the write entirely (e.g. "repo
 * already saved, nothing to do" — the file is left byte-identical, not
 * rewritten). Any other return value writes.
 *
 * Returns the snapshot that is now on disk (or would be, when skipped).
 */
export function updateStateFile(mutate: (state: StateSnapshot) => boolean | undefined): StateSnapshot {
  const state = loadStateFile()
  const shouldWrite = mutate(state)
  if (shouldWrite !== false) writeStateFile(state)
  return state
}

/**
 * Merge a set of key changes into the file: fresh read, apply ONLY the
 * keys present in `patch` (an explicit `undefined` value DELETES the key —
 * matching the old whole-snapshot behavior where stringify dropped
 * undefined entries), atomic write. This is the multi-process-safe flush
 * primitive: KVProvider passes just its dirty keys; `setPersisted*` passes
 * a single key. Keys this writer never touched pass through untouched.
 */
export function patchStateFile(patch: StateSnapshot): StateSnapshot {
  return updateStateFile((state) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state[key]
      else state[key] = value
    }
    return undefined
  })
}

/**
 * Read a boolean flag from state.json with an explicit default — the single
 * owner of the "stored bool with a default" rule. Only a real stored boolean
 * overrides `defaultValue`; a missing key OR any non-boolean value falls back.
 * This subsumes the `x === true` (default false) / `x !== false` (default true)
 * idioms flag modules would otherwise inline, where the idiom silently
 * encodes the default and is easy to get backwards.
 */
export function getPersistedBool(key: string, defaultValue: boolean): boolean {
  const value = loadStateFile()[key]
  return typeof value === "boolean" ? value : defaultValue
}

/** Persist a boolean flag — single-key read-merge-write via {@link patchStateFile}. */
export function setPersistedBool(key: string, value: boolean): void {
  patchStateFile({ [key]: value })
}

/**
 * Replace the WHOLE file with `snapshot`, discarding keys other processes
 * may have written. Deliberately destructive — the only legitimate caller
 * is KVProvider's `clear()` ("reset UI state" in Settings → Dev), whose
 * contract is "wipe every persisted key, including ones this process never
 * loaded". Everything else must go through {@link patchStateFile} /
 * {@link updateStateFile}; reaching for this in a normal write path
 * reintroduces the lost-update bug this module exists to fix.
 */
export function replaceStateFile(snapshot: StateSnapshot): void {
  writeStateFile(snapshot)
}
