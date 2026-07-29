/**
 * `kobe plugin outdated` / `kobe plugin update` — keeping GitHub-installed
 * plugins fresh. The staleness check is one `git ls-remote HEAD` per plugin
 * against the managed checkout's local HEAD (the install keeps its clone's
 * `.git`); an update is a plain reinstall through `installPlugin` — the
 * checkout is replaceable by design, config/state live outside it. Linked
 * plugins are the author's working tree and are never touched.
 *
 * Every check/update rewrites the outdated CACHE file the Settings →
 * Plugins section reads for its "update available" mark — the TUI itself
 * never talks to the network.
 */

import { execFileSync } from "node:child_process"
import { writeOutdatedCache } from "@sma1lboy/kobe-daemon/plugins/outdated-cache"
import { pluginCheckoutDir } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import { type PluginRegistryEntry, loadPluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { PluginCliError, installPlugin } from "./plugin-install.ts"

export interface OutdatedRow {
  readonly id: string
  readonly spec: string
  readonly version: string
  /** null when the checkout has no readable git HEAD. */
  readonly localSha: string | null
  /** null when the remote probe failed (offline, repo gone). */
  readonly remoteSha: string | null
  readonly behind: boolean
}

function gitOut(args: string[], cwd?: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

function checkEntry(entry: PluginRegistryEntry & { source: { kind: "github"; spec: string } }): OutdatedRow {
  const repoSpec = entry.source.spec.split("/").slice(0, 2).join("/")
  const localSha = gitOut(["rev-parse", "HEAD"], pluginCheckoutDir(entry.id))
  const remote = gitOut(["ls-remote", `https://github.com/${repoSpec}.git`, "HEAD"])
  const remoteSha = remote ? (remote.split(/\s+/)[0] ?? null) : null
  return {
    id: entry.id,
    spec: entry.source.spec,
    version: entry.version,
    localSha,
    remoteSha,
    behind: Boolean(localSha && remoteSha && localSha !== remoteSha),
  }
}

/** Probe every GitHub-installed plugin; refreshes the Settings cache. */
export function listOutdated(): OutdatedRow[] {
  const rows = loadPluginRegistry()
    .plugins.filter(
      (p): p is PluginRegistryEntry & { source: { kind: "github"; spec: string } } => p.source.kind === "github",
    )
    .map(checkEntry)
  writeOutdatedCache(rows.filter((r) => r.behind).map((r) => r.id))
  return rows
}

export function printOutdated(): void {
  const rows = listOutdated()
  if (rows.length === 0) {
    console.log("no GitHub-installed plugins.")
    return
  }
  for (const r of rows) {
    const status = r.behind
      ? "update available"
      : r.remoteSha === null
        ? "remote unreachable"
        : r.localSha === null
          ? "local sha unreadable"
          : "up to date"
    console.log(`${r.id}  v${r.version}  ${status}`)
  }
}

/** Reinstall the named plugins — or with `all`, every stale one. */
export async function updatePlugins(ids: readonly string[], opts: { all: boolean; yes: boolean }): Promise<void> {
  const rows = listOutdated()
  let targets: OutdatedRow[]
  if (opts.all) {
    targets = rows.filter((r) => r.behind)
    if (targets.length === 0) {
      console.log("all plugins up to date.")
      return
    }
  } else {
    if (ids.length === 0) throw new PluginCliError("update takes plugin ids or --all")
    targets = ids.map((id) => {
      const row = rows.find((r) => r.id === id)
      if (!row) throw new PluginCliError(`\`${id}\` is not a GitHub-installed plugin; see \`kobe plugin list\``)
      return row
    })
  }
  for (const target of targets) {
    if (!target.behind && !ids.includes(target.id)) continue
    console.log(`updating ${target.id} (${target.spec})…`)
    await installPlugin(target.spec, { yes: opts.yes })
  }
  // Reinstall moved HEADs — refresh the cache so Settings drops its marks.
  listOutdated()
}
