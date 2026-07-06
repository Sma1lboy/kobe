import { ALL_VENDORS, type VendorId } from "@/types/vendor"

export function resolveVendorSet(available: readonly VendorId[] | undefined): readonly VendorId[] {
  return available && available.length > 0 ? available : ALL_VENDORS
}

export function resolveInitialVendor(set: readonly VendorId[], preferred: VendorId | undefined): VendorId {
  const pref = preferred ?? "claude"
  return set.includes(pref) ? pref : (set[0] ?? "claude")
}

export function toggleInSet(prev: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(prev)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export function toggleSelectAll(prev: ReadonlySet<string>, paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return prev
  const allSelected = paths.every((p) => prev.has(p))
  return allSelected ? new Set<string>() : new Set(paths)
}
