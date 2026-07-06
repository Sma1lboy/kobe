/**
 * Abstract base for engine hook adapters whose engine uses the shared
 * settings.json hook shape (Claude Code's `~/.claude/settings.json`, Codex's
 * `~/.codex/hooks.json`). It owns EVERYTHING vendor-neutral: the best-effort
 * read→merge→write I/O and the four install/remove methods, all delegating to
 * the pure merge core in `./json-hooks`. A concrete adapter supplies only its
 * vendor id, its event→verb table ({@link eventMap}), and its settings path —
 * plus any vendor-specific override (Claude adds `error_type`/permission detail
 * decoding + the legacy `WorktreeCreate` cleanup).
 *
 * This is the seam the architecture promises: "adding a new engine = a new
 * adapter file." For a same-shape engine that file is ~3 members.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { VendorId } from "../types/vendor.ts"
import type { EngineHookAdapter } from "./hook-adapter.ts"
import type { EngineActivityDetail, EngineActivityKind } from "./hook-events.ts"
import { type HookEventSpec, isObject, mergeActivityHooks, mergeWorktreeWatchHook } from "./json-hooks.ts"

/** Read a JSON object from `path`, or {} if absent/unparseable/not-an-object. */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Read → transform → write a SHARED settings file, skipping the write when the
 * transform is a no-op (the default-on installers run on every launch; don't
 * churn the user's file mtime / VCS status when the hooks are already in place).
 * Best-effort: a failure to read/parse/write must never block a launch.
 */
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
  } catch {
    /* best-effort — never block launch */
  }
}

export abstract class JsonHookAdapter implements EngineHookAdapter {
  abstract readonly vendor: VendorId
  /** This engine's hook event → neutral verb table (the ONE vendor-specific bit). */
  protected abstract readonly eventMap: readonly HookEventSpec[]
  /** This engine's global hook settings file. */
  abstract globalSettingsPath(): string

  supportsHooks(): boolean {
    return true
  }

  /** Default: no verb carries extra detail. Engines with failure/permission
   *  events (Claude) override this. */
  activityDetailFromPayload(
    _kind: EngineActivityKind,
    _payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined {
    return undefined
  }

  /** Default: this engine never installed the legacy `WorktreeCreate` provider
   *  hook, so there's nothing to clean up. Claude overrides both. */
  supportsWorktreeSync(): boolean {
    return false
  }

  async removeWorktreeSyncHook(_settingsFilePath: string): Promise<void> {
    /* no-op unless overridden */
  }

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
