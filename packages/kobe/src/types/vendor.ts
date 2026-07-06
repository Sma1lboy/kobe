export type VendorId = "claude" | "codex" | "copilot" | (string & {})

export const BUILTIN_VENDORS = ["claude", "codex", "copilot"] as const
export type BuiltinVendorId = (typeof BUILTIN_VENDORS)[number]

export const ALL_VENDORS: readonly VendorId[] = [...BUILTIN_VENDORS]

export function isBuiltinVendor(id: string | undefined): id is BuiltinVendorId {
  return id === "claude" || id === "codex" || id === "copilot"
}

export function nextVendor(current: VendorId): VendorId {
  const i = ALL_VENDORS.indexOf(current)
  return ALL_VENDORS[(i + 1) % ALL_VENDORS.length] ?? ALL_VENDORS[0]
}

export function nextVendorWithin(list: readonly VendorId[], current: VendorId): VendorId {
  if (list.length === 0) return current
  const i = list.indexOf(current)
  return list[(i + 1) % list.length] ?? list[0] ?? current
}

export function prevVendorWithin(list: readonly VendorId[], current: VendorId): VendorId {
  if (list.length === 0) return current
  const i = list.indexOf(current)
  if (i < 0) return list[list.length - 1] ?? current
  return list[(i - 1 + list.length) % list.length] ?? current
}

export function coerceVendorId(value: string | undefined): VendorId {
  const v = value?.trim()
  return v && v.length > 0 ? v : "claude"
}

export function resolvePersistedVendor(value: string | undefined, customEngineIds: readonly string[] = []): VendorId {
  const v = value?.trim()
  if (!v) return "claude"
  if (isBuiltinVendor(v)) return v
  if (customEngineIds.includes(v)) return v
  return "claude"
}
