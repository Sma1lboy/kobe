/**
 * Plugin settings storage — plain `KEY=value` lines in the plugin's config
 * `.env` (the file plugin commands already source). The `[[settings]]`
 * manifest section is the SCHEMA; this module is the store: read current
 * values, merge edits in place, and resolve the Files-pane file handlers.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type PluginManifest, qualifiedActionId, readPluginManifest } from "./manifest.ts"
import { pluginConfigDir } from "./plugin-paths.ts"
import { loadPluginRegistry } from "./registry.ts"

function envPath(pluginId: string, homeDir?: string): string {
  return join(pluginConfigDir(pluginId, homeDir), ".env")
}

/** Current `KEY=value` pairs from the plugin's config .env (missing → {}). */
export function readPluginSettings(pluginId: string, homeDir?: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(envPath(pluginId, homeDir), "utf8")
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}

/**
 * Merge `values` into the .env, preserving unrelated lines/comments. An
 * empty-string value REMOVES the key (booleans store "1" or absent).
 */
export function writePluginSettings(pluginId: string, values: Record<string, string>, homeDir?: string): void {
  const path = envPath(pluginId, homeDir)
  let lines: string[] = []
  try {
    lines = readFileSync(path, "utf8").split("\n")
  } catch {
    /* fresh file */
  }
  const remaining = { ...values }
  const next: string[] = []
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    const key = m?.[1]
    if (key && key in remaining) {
      const value = remaining[key] as string
      delete remaining[key]
      if (value !== "") next.push(`${key}=${value}`)
      continue // empty → drop the line
    }
    next.push(line)
  }
  for (const [key, value] of Object.entries(remaining)) {
    if (value !== "") next.push(`${key}=${value}`)
  }
  while (next.length > 0 && next[next.length - 1] === "") next.pop()
  mkdirSync(pluginConfigDir(pluginId, homeDir), { recursive: true })
  writeFileSync(path, next.length > 0 ? `${next.join("\n")}\n` : "")
}

/**
 * The Files-pane routing question: does an enabled plugin claim this file?
 * First enabled plugin (registry order) with a matching `[[file_handlers]]`
 * pattern wins; returns the qualified action to invoke with the file path.
 */
export function findFileHandler(fileName: string, homeDir?: string): { qualifiedAction: string } | null {
  for (const entry of loadPluginRegistry(homeDir).plugins) {
    if (!entry.enabled) continue
    let manifest: PluginManifest
    try {
      manifest = readPluginManifest(entry.root).manifest
    } catch {
      continue
    }
    for (const handler of manifest.fileHandlers) {
      try {
        if (new RegExp(handler.pattern, "i").test(fileName)) {
          return { qualifiedAction: qualifiedActionId(entry.id, handler.action) }
        }
      } catch {
        /* bad pattern → skip */
      }
    }
  }
  return null
}
