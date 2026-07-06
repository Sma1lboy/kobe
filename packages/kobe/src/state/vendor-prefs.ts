import { DEFAULT_TASK_VENDOR } from "../types/task.ts"
import { type VendorId, isBuiltinVendor } from "../types/vendor.ts"
import { getCustomEngineIds, getPersistedString, setPersistedString } from "./repos.ts"

const REPO_KEY_PREFIX = "lastActiveVendor."

function validVendor(value: string | undefined, customIds: readonly string[]): VendorId | undefined {
  const v = value?.trim()
  if (!v) return undefined
  if (isBuiltinVendor(v) || customIds.includes(v)) return v
  return undefined
}

export function getRepoLastActiveVendor(repo: string): VendorId | undefined {
  return validVendor(getPersistedString(REPO_KEY_PREFIX + repo), getCustomEngineIds())
}

export function setRepoLastActiveVendor(repo: string, vendor: VendorId): void {
  setPersistedString(REPO_KEY_PREFIX + repo, vendor)
}

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

export function resolvePreferredVendor(repo?: string): VendorId {
  const repoPick = repo ? getRepoLastActiveVendor(repo) : undefined
  return repoPick ?? getGlobalDefaultVendor() ?? DEFAULT_TASK_VENDOR
}
