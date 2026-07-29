/**
 * Filesystem layout for installed plugins, all under `<home>/.kobe/`:
 *
 *   plugins.json                  — the registry (see plugins/registry.ts)
 *   plugins/<id>/checkout/        — managed source checkout (GitHub installs only)
 *   plugins/<id>/config/          — user-editable config (.env etc.); plugin-owned format
 *   plugins/<id>/state/           — plugin-owned runtime state
 *   plugins/<id>/log.jsonl        — command-run log (appended by the runtime)
 *
 * Linked (local-dev) plugins keep their root wherever the author works;
 * config/state still live here so uninstall/relink never loses user data.
 */

import { homedir } from "node:os"
import { join } from "node:path"

function stateRoot(homeDir?: string): string {
  return join(homeDir ?? process.env.KOBE_HOME_DIR ?? homedir(), ".kobe")
}

export function pluginRegistryPath(homeDir?: string): string {
  return join(stateRoot(homeDir), "plugins.json")
}

export function pluginDataDir(id: string, homeDir?: string): string {
  return join(stateRoot(homeDir), "plugins", id)
}

export function pluginCheckoutDir(id: string, homeDir?: string): string {
  return join(pluginDataDir(id, homeDir), "checkout")
}

export function pluginConfigDir(id: string, homeDir?: string): string {
  return join(pluginDataDir(id, homeDir), "config")
}

export function pluginStateDir(id: string, homeDir?: string): string {
  return join(pluginDataDir(id, homeDir), "state")
}

export function pluginLogPath(id: string, homeDir?: string): string {
  return join(pluginDataDir(id, homeDir), "log.jsonl")
}

/** CLI-written `plugin outdated` cache the Settings pane reads (advisory). */
export function pluginsOutdatedCachePath(homeDir?: string): string {
  return join(stateRoot(homeDir), "plugins-outdated.json")
}
