/**
 * `<home>/.kobe/plugins.json` — the installed/linked plugin registry.
 *
 * Written by the `kobe plugin` CLI; read (and file-watched) by the daemon's
 * plugin runtime. Registration is global to the user, like herdr's: one list
 * for every session. The file is small and rewritten whole on every mutation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { pluginRegistryPath } from "./plugin-paths.ts"

export interface PluginRegistryEntry {
  readonly id: string
  /** `github` = managed checkout under plugins/<id>/checkout; `link` = author's working dir. */
  readonly source: { readonly kind: "github"; readonly spec: string } | { readonly kind: "link" }
  /** Absolute plugin root (the directory containing kobe-plugin.toml). */
  readonly root: string
  readonly enabled: boolean
  readonly version: string
  readonly installedAt: number
}

export interface PluginRegistry {
  readonly plugins: readonly PluginRegistryEntry[]
}

const EMPTY: PluginRegistry = { plugins: [] }

export function loadPluginRegistry(homeDir?: string): PluginRegistry {
  let text: string
  try {
    text = readFileSync(pluginRegistryPath(homeDir), "utf8")
  } catch {
    return EMPTY
  }
  try {
    const raw = JSON.parse(text) as { plugins?: unknown }
    if (!Array.isArray(raw.plugins)) return EMPTY
    return { plugins: raw.plugins.filter(isEntry) }
  } catch {
    // A corrupt registry disables plugins rather than crashing the daemon;
    // the next CLI mutation rewrites it whole.
    return EMPTY
  }
}

function isEntry(v: unknown): v is PluginRegistryEntry {
  if (typeof v !== "object" || v === null) return false
  const e = v as Record<string, unknown>
  const source = e.source as Record<string, unknown> | undefined
  return (
    typeof e.id === "string" &&
    typeof e.root === "string" &&
    typeof e.enabled === "boolean" &&
    typeof e.version === "string" &&
    typeof e.installedAt === "number" &&
    typeof source === "object" &&
    source !== null &&
    (source.kind === "link" || (source.kind === "github" && typeof source.spec === "string"))
  )
}

export function savePluginRegistry(registry: PluginRegistry, homeDir?: string): void {
  const path = pluginRegistryPath(homeDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`)
}

/** Insert or replace the entry with the same id. */
export function upsertPluginEntry(registry: PluginRegistry, entry: PluginRegistryEntry): PluginRegistry {
  return { plugins: [...registry.plugins.filter((p) => p.id !== entry.id), entry] }
}

export function removePluginEntry(registry: PluginRegistry, id: string): PluginRegistry {
  return { plugins: registry.plugins.filter((p) => p.id !== id) }
}
