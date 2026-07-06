import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { VendorId } from "../types/vendor.ts"
import type { EngineHookAdapter } from "./hook-adapter.ts"
import type { EngineActivityDetail, EngineActivityKind } from "./hook-events.ts"
import { type HookEventSpec, isObject, mergeActivityHooks, mergeWorktreeWatchHook } from "./json-hooks.ts"

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function editJsonSettings(
  settingsFilePath: string,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  try {
    const current = await readJsonObject(settingsFilePath)
    const next = transform(current)
    if (JSON.stringify(next) === JSON.stringify(current)) return
    await mkdir(dirname(settingsFilePath), { recursive: true })
    await writeFile(settingsFilePath, `${JSON.stringify(next, null, 2)}\n`)
  } catch {}
}

export abstract class JsonHookAdapter implements EngineHookAdapter {
  abstract readonly vendor: VendorId
  protected abstract readonly eventMap: readonly HookEventSpec[]
  abstract globalSettingsPath(): string

  supportsHooks(): boolean {
    return true
  }

  activityDetailFromPayload(
    _kind: EngineActivityKind,
    _payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined {
    return undefined
  }

  supportsWorktreeSync(): boolean {
    return false
  }

  async removeWorktreeSyncHook(_settingsFilePath: string): Promise<void> {}

  async installActivityHooks(settingsFilePath: string): Promise<void> {
    await editJsonSettings(settingsFilePath, (cur) => mergeActivityHooks(cur, true, this.eventMap))
  }

  async removeActivityHooks(settingsFilePath: string): Promise<void> {
    await editJsonSettings(settingsFilePath, (cur) => mergeActivityHooks(cur, false, this.eventMap))
  }

  async installWorktreeWatchHook(settingsFilePath: string): Promise<void> {
    await editJsonSettings(settingsFilePath, (cur) => mergeWorktreeWatchHook(cur, true))
  }

  async removeWorktreeWatchHook(settingsFilePath: string): Promise<void> {
    await editJsonSettings(settingsFilePath, (cur) => mergeWorktreeWatchHook(cur, false))
  }
}
