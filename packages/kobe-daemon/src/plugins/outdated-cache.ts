/**
 * The `plugin outdated` cache — the advisory handshake between the CLI
 * (which does the network probe and writes) and Settings → Plugins (which
 * only reads, so the TUI never touches the network). Stale or missing
 * cache simply means "no marks".
 */

import { readFileSync, writeFileSync } from "node:fs"
import { pluginsOutdatedCachePath } from "./plugin-paths.ts"

export interface PluginsOutdatedCache {
  readonly checkedAt: number
  readonly outdated: readonly string[]
}

/** Checks older than this stop driving the Settings mark. */
export const OUTDATED_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function writeOutdatedCache(outdatedIds: readonly string[], homeDir?: string): void {
  const cache: PluginsOutdatedCache = { checkedAt: Date.now(), outdated: outdatedIds }
  try {
    writeFileSync(pluginsOutdatedCachePath(homeDir), `${JSON.stringify(cache, null, 2)}\n`)
  } catch {
    /* advisory */
  }
}

/** Cached outdated plugin ids; [] when missing, malformed, or stale. */
export function readOutdatedCache(homeDir?: string): readonly string[] {
  try {
    const cache = JSON.parse(readFileSync(pluginsOutdatedCachePath(homeDir), "utf8")) as PluginsOutdatedCache
    if (typeof cache.checkedAt !== "number" || !Array.isArray(cache.outdated)) return []
    if (Date.now() - cache.checkedAt > OUTDATED_CACHE_TTL_MS) return []
    return cache.outdated.filter((id): id is string => typeof id === "string")
  } catch {
    return []
  }
}
