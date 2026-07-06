/**
 * Vendor preference layers, as flat keys in the shared `state.json`:
 * `lastActiveVendor.<repo>` (per-project, written by Ctrl+Shift+T and
 * dialog picks) → `defaultVendor` (global, Settings-only) →
 * `lastSelectedVendor` (legacy pre-split key, read-only) → `claude`.
 * Per-TASK vendor lives on the task record, not here.
 */

import { DEFAULT_TASK_VENDOR } from "../types/task.ts"
import { type VendorId, isBuiltinVendor } from "../types/vendor.ts"
import { getCustomEngineIds, getPersistedString, setPersistedString } from "./repos.ts"

const REPO_KEY_PREFIX = "lastActiveVendor."

/** Validate one persisted value; undefined lets the chain fall through. */
function validVendor(value: string | undefined, customIds: readonly string[]): VendorId | undefined {
  const v = value?.trim()
  if (!v) return undefined
  if (isBuiltinVendor(v) || customIds.includes(v)) return v
  return undefined
}

/** The project's last actively-used engine (undefined = never recorded). */
export function getRepoLastActiveVendor(repo: string): VendorId | undefined {
  return validVendor(getPersistedString(REPO_KEY_PREFIX + repo), getCustomEngineIds())
}

export function setRepoLastActiveVendor(repo: string, vendor: VendorId): void {
  setPersistedString(REPO_KEY_PREFIX + repo, vendor)
}

/** The Settings-owned global default (legacy key honored; undefined = unset). */
export function getGlobalDefaultVendor(): VendorId | undefined {
  const customIds = getCustomEngineIds()
  return (
    validVendor(getPersistedString("defaultVendor"), customIds) ??
    validVendor(getPersistedString("lastSelectedVendor"), customIds)
  )
}

export function setGlobalDefaultVendor(vendor: VendorId): void {
  setPersistedString("defaultVendor", vendor)
}

/**
 * The vendor a new task / relaunch should default to: the repo's last-active
 * engine, else the Settings global default, else `claude`. Each level is
 * validated independently, so a corrupt repo entry falls through to the
 * global default rather than straight to the built-in fallback.
 */
export function resolvePreferredVendor(repo?: string): VendorId {
  const repoPick = repo ? getRepoLastActiveVendor(repo) : undefined
  return repoPick ?? getGlobalDefaultVendor() ?? DEFAULT_TASK_VENDOR
}
