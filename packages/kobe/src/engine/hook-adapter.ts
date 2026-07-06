import type { VendorId } from "../types/vendor.ts"
import type { EngineActivityDetail, EngineActivityKind } from "./hook-events.ts"
import { engineEntry } from "./registry.ts"

export interface EngineHookAdapter {
  readonly vendor: VendorId
  supportsHooks(): boolean
  globalSettingsPath(): string
  activityDetailFromPayload(
    kind: EngineActivityKind,
    payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined
  installActivityHooks(settingsFilePath: string): Promise<void>
  removeActivityHooks(settingsFilePath: string): Promise<void>

  supportsWorktreeSync(): boolean
  removeWorktreeSyncHook(settingsFilePath: string): Promise<void>

  installWorktreeWatchHook(settingsFilePath: string): Promise<void>
  removeWorktreeWatchHook(settingsFilePath: string): Promise<void>
}

export function createEngineHookAdapter(vendor: VendorId): EngineHookAdapter {
  return engineEntry(vendor).createHookAdapter()
}

export class NoopHookAdapter implements EngineHookAdapter {
  constructor(readonly vendor: VendorId) {}
  supportsHooks(): boolean {
    return false
  }
  globalSettingsPath(): string {
    return ""
  }
  activityDetailFromPayload(): EngineActivityDetail | undefined {
    return undefined
  }
  async installActivityHooks(): Promise<void> {}
  async removeActivityHooks(): Promise<void> {}
  supportsWorktreeSync(): boolean {
    return false
  }
  async removeWorktreeSyncHook(): Promise<void> {}
  async installWorktreeWatchHook(): Promise<void> {}
  async removeWorktreeWatchHook(): Promise<void> {}
}
