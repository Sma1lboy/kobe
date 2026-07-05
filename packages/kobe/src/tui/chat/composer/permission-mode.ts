import type { EngineCapabilities, PermissionMode } from "@/types/engine"

export function permissionModeLabel(
  capabilities: Pick<EngineCapabilities, "permissionModes">,
  mode: PermissionMode | undefined,
): string {
  const id = mode ?? "default"
  return capabilities.permissionModes.find((m) => m.id === id)?.label ?? id
}
