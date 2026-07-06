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
 * Corrupt-file policy (preserved from both former writers): a missing or
 * unparseable state.json reads as `{}` and is silently rebuilt on the next
 * write. A corrupt state file must never block the UI or a CLI command —
 * the data here is all reconstructible preference state.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kvStatePath } from "../env.ts"

/** The flat JSON object persisted at `kvStatePath()`. */
export type StateSnapshot = Record<string, unknown>

/**
 * Read + parse the state file. Returns `{}` for a missing file, malformed
 * JSON, or a non-object root (array/string/number) — see the corrupt-file
 * policy in the module doc. Never throws.
 */
export function loadStateFile(): StateSnapshot {
  try {
    const text = readFileSync(kvStatePath(), "utf8")
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StateSnapshot
    }
  } catch {
    // Missing file or malformed JSON: start fresh. We don't surface the
    // error — a corrupt state file shouldn't block the UI or a CLI run.
  }
  return {}
}

/**
 * Atomic whole-file write: serialize to `state.json.tmp`, then rename over
 * `state.json` so a crash mid-write can never leave a half-written file.
 * `undefined` values vanish at JSON.stringify time, which is how key
 * deletion serializes. Throws on I/O failure — callers decide whether
 * that's fatal (CLI) or logged-and-retried (KVProvider's next flush).
 */
function writeStateFile(state: StateSnapshot): void {
  const path = kvStatePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
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
