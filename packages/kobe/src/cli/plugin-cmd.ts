/**
 * `kobe plugin` — install, link, inspect, and invoke plugins.
 *
 * A plugin is a directory with a `kobe-plugin.toml` manifest; the whole
 * `kobe` CLI is the plugin API (docs/design/plugins.md). This command owns
 * the registry (`~/.kobe/plugins.json`); the daemon's PluginHost watches
 * that file, so mutations here apply to a running daemon without a restart.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { errorMessage } from "@/lib/error-message"
import { defaultDaemonSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import { buildPluginEnv } from "@sma1lboy/kobe-daemon/plugins/env"
import {
  PLUGIN_MANIFEST_FILENAME,
  type PluginManifest,
  parsePluginManifest,
  qualifiedActionId,
} from "@sma1lboy/kobe-daemon/plugins/manifest"
import { buildPaneArgv } from "@sma1lboy/kobe-daemon/plugins/pane-command"
import { pluginCheckoutDir, pluginConfigDir, pluginLogPath } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import {
  type PluginRegistryEntry,
  loadPluginRegistry,
  removePluginEntry,
  savePluginRegistry,
} from "@sma1lboy/kobe-daemon/plugins/registry"
import { PluginCliError, installPlugin, linkPlugin } from "./plugin-install.ts"

function printUsage(out: NodeJS.WriteStream): void {
  out.write(
    [
      "usage: kobe plugin <command>",
      "",
      "  install <owner/repo[/subdir]> [--yes] [--ref <rev>]   clone from GitHub, preview, build, register",
      "  link <dir>                                            register a local plugin directory (dev)",
      "  list                                                  installed + linked plugins",
      "  search [query]                                        browse the marketplace (GitHub topic kobe-plugin)",
      "  enable <id> | disable <id>                            toggle a plugin without unregistering it",
      "  unlink <id>                                           unregister a linked plugin (files untouched)",
      "  uninstall <id-or-spec>                                unregister + remove the managed checkout",
      "  config-dir <id>                                       print the plugin's config directory",
      "  log <id> [-n <count>]                                 tail the plugin's command-run log",
      "  action list [--plugin <id>]                           declared actions",
      "  action invoke <plugin-id.action-id>                   run an action now",
      "  pane open --plugin <id> --entrypoint <pane-id>        open a plugin pane as a terminal tab",
      "",
      "Marketplace: https://github.com/topics/kobe-plugin — docs: docs/design/plugins.md",
      "",
    ].join("\n"),
  )
}

interface LoadedEntry {
  readonly entry: PluginRegistryEntry
  readonly manifest: PluginManifest | undefined
}

function loadAll(): LoadedEntry[] {
  return loadPluginRegistry().plugins.map((entry) => {
    try {
      const text = readFileSync(join(entry.root, PLUGIN_MANIFEST_FILENAME), "utf8")
      return { entry, manifest: parsePluginManifest(text).manifest }
    } catch {
      return { entry, manifest: undefined }
    }
  })
}

function requireEntry(id: string): PluginRegistryEntry {
  const entry = loadPluginRegistry().plugins.find((p) => p.id === id)
  if (!entry) throw new PluginCliError(`no plugin registered as \`${id}\`; see \`kobe plugin list\``)
  return entry
}

function listPlugins(): void {
  const all = loadAll()
  if (all.length === 0) {
    console.log("no plugins installed. Try: kobe plugin install <owner/repo> — browse the `kobe-plugin` GitHub topic.")
    return
  }
  for (const { entry, manifest } of all) {
    const state = entry.enabled ? "enabled" : "disabled"
    const kind = entry.source.kind === "link" ? `linked ${entry.root}` : entry.source.spec
    const broken = manifest ? "" : "  [manifest unreadable]"
    console.log(`${entry.id}  v${entry.version}  ${state}  (${kind})${broken}`)
  }
}

function setEnabled(id: string, enabled: boolean): void {
  const entry = requireEntry(id)
  const registry = loadPluginRegistry()
  savePluginRegistry({
    plugins: registry.plugins.map((p) => (p.id === id ? { ...entry, enabled } : p)),
  })
  console.log(`${enabled ? "enabled" : "disabled"} ${id}`)
}

function unlink(id: string): void {
  const entry = requireEntry(id)
  if (entry.source.kind !== "link") throw new PluginCliError(`\`${id}\` is a GitHub install; use uninstall`)
  savePluginRegistry(removePluginEntry(loadPluginRegistry(), id))
  console.log(`unlinked ${id} (files untouched at ${entry.root})`)
}

function uninstall(idOrSpec: string): void {
  const registry = loadPluginRegistry()
  const entry = registry.plugins.find(
    (p) => p.id === idOrSpec || (p.source.kind === "github" && p.source.spec === idOrSpec),
  )
  if (!entry) throw new PluginCliError(`no plugin registered as \`${idOrSpec}\``)
  if (entry.source.kind === "link") throw new PluginCliError(`\`${entry.id}\` is linked; use unlink`)
  savePluginRegistry(removePluginEntry(registry, entry.id))
  // Managed checkout goes; config/ and state/ stay so a reinstall keeps user data.
  rmSync(pluginCheckoutDir(entry.id), { recursive: true, force: true })
  console.log(`uninstalled ${entry.id} (config/state kept under ~/.kobe/plugins/${entry.id}/)`)
}

function listActions(pluginFilter?: string): void {
  for (const { entry, manifest } of loadAll()) {
    if (!manifest || (pluginFilter && entry.id !== pluginFilter)) continue
    for (const action of manifest.actions) {
      console.log(`${qualifiedActionId(entry.id, action.id)}  ${action.title}`)
    }
  }
}

function invokeAction(qualified: string, extraArgs: string[]): void {
  // Plugin ids may contain dots; match registered ids by longest prefix.
  const candidates = loadAll()
    .filter(({ entry, manifest }) => manifest && entry.enabled && qualified.startsWith(`${entry.id}.`))
    .sort((a, b) => b.entry.id.length - a.entry.id.length)
  const hit = candidates
    .map(({ entry, manifest }) => {
      const actionId = qualified.slice(entry.id.length + 1)
      const action = (manifest as PluginManifest).actions.find((a) => a.id === actionId)
      return action ? { entry, action } : undefined
    })
    .find(Boolean)
  if (!hit) throw new PluginCliError(`no action \`${qualified}\`; see \`kobe plugin action list\``)

  // Extra CLI args are appended to the action's argv so an action can take
  // an argument (`kobe plugin action invoke p.start <url>`).
  const [cmd, ...args] = [...hit.action.command, ...extraArgs]
  const res = spawnSync(cmd as string, args, {
    cwd: hit.entry.root,
    stdio: "inherit",
    env: buildPluginEnv({
      socketPath: defaultDaemonSocketPath(),
      binPath: "kobe",
      pluginId: hit.entry.id,
      pluginRoot: hit.entry.root,
      extra: { KOBE_PLUGIN_ACTION_ID: hit.action.id, KOBE_PLUGIN_INVOKE_CWD: process.cwd() },
    }),
  })
  process.exit(res.status ?? 1)
}

/** Resolve `<plugin-id>.<pane-id>` (plugin ids may contain dots — longest registered prefix wins). */
function resolvePaneQualified(qualified: string): { pluginId: string; entrypoint: string } {
  const hit = loadAll()
    .filter(({ entry, manifest }) => manifest && qualified.startsWith(`${entry.id}.`))
    .sort((a, b) => b.entry.id.length - a.entry.id.length)
    .find(({ entry, manifest }) =>
      (manifest as PluginManifest).panes.some((p) => p.id === qualified.slice(entry.id.length + 1)),
    )
  if (!hit) throw new PluginCliError(`no pane \`${qualified}\`; see \`kobe plugin list\``)
  return { pluginId: hit.entry.id, entrypoint: qualified.slice(hit.entry.id.length + 1) }
}

async function openPane(pluginId: string, entrypoint: string, taskFlag: string | undefined): Promise<void> {
  const loaded = loadAll().find(({ entry }) => entry.id === pluginId)
  if (!loaded?.manifest) throw new PluginCliError(`no plugin \`${pluginId}\` (or its manifest is unreadable)`)
  if (!loaded.entry.enabled) throw new PluginCliError(`\`${pluginId}\` is disabled`)
  const pane = loaded.manifest.panes.find((p) => p.id === entrypoint)
  if (!pane) throw new PluginCliError(`no pane \`${entrypoint}\` in \`${pluginId}\`; declare it under [[panes]]`)

  // Shared composition with the TUI's ctrl+e picker (plugins/pane-command.ts):
  // one `sh -lc` script, env contract riding an `env` prefix, cwd = worktree.
  const argv = buildPaneArgv(loaded.entry.id, loaded.entry.root, pane, {
    socketPath: defaultDaemonSocketPath(),
    binPath: "kobe",
  })

  const { openDaemonSession } = await import("./daemon-session.ts")
  const { resolveActiveTaskId } = await import("./api/runtime.ts")
  const session = await openDaemonSession({ mode: "start" })
  try {
    const taskId = taskFlag ?? (await resolveActiveTaskId(session.client))
    if (!taskId) throw new PluginCliError("no active task; pass --task <id>")
    await session.client.request("tab.open", {
      taskId,
      argv,
      title: pane.title,
      placement: pane.placement,
    })
    console.log(`opened pane ${pluginId}.${pane.id} in task ${taskId}`)
  } finally {
    session.close()
  }
}

function tailLog(id: string, count: number): void {
  requireEntry(id)
  let text: string
  try {
    text = readFileSync(pluginLogPath(id), "utf8")
  } catch {
    console.log("(no runs logged yet)")
    return
  }
  const lines = text.trimEnd().split("\n")
  for (const line of lines.slice(-count)) console.log(line)
}

function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag)
  return i >= 0 ? rest[i + 1] : undefined
}

export async function runPluginSubcommand(rest: string[]): Promise<void> {
  const [command, ...args] = rest
  try {
    switch (command) {
      case "install": {
        const spec = args.find((a) => !a.startsWith("-"))
        if (!spec) throw new PluginCliError("install needs <owner/repo[/subdir]>")
        await installPlugin(spec, { yes: args.includes("--yes"), ref: flagValue(args, "--ref") })
        return
      }
      case "link": {
        if (!args[0]) throw new PluginCliError("link needs a directory")
        linkPlugin(args[0])
        return
      }
      case "list":
        listPlugins()
        return
      case "search": {
        const { searchMarketplace } = await import("./plugin-search.ts")
        await searchMarketplace(args.find((a) => !a.startsWith("-")))
        return
      }
      case "enable":
      case "disable": {
        if (!args[0]) throw new PluginCliError(`${command} needs a plugin id`)
        setEnabled(args[0], command === "enable")
        return
      }
      case "unlink": {
        if (!args[0]) throw new PluginCliError("unlink needs a plugin id")
        unlink(args[0])
        return
      }
      case "uninstall": {
        if (!args[0]) throw new PluginCliError("uninstall needs a plugin id or owner/repo spec")
        uninstall(args[0])
        return
      }
      case "config-dir": {
        if (!args[0]) throw new PluginCliError("config-dir needs a plugin id")
        requireEntry(args[0])
        console.log(pluginConfigDir(args[0]))
        return
      }
      case "log": {
        if (!args[0]) throw new PluginCliError("log needs a plugin id")
        tailLog(args[0], Number.parseInt(flagValue(args, "-n") ?? "20", 10) || 20)
        return
      }
      case "pane": {
        const [sub, ...paneArgs] = args
        if (sub === "open") {
          const positional = paneArgs.find((a) => !a.startsWith("-") && a !== flagValue(paneArgs, "--task"))
          let pluginId = flagValue(paneArgs, "--plugin")
          let entrypoint = flagValue(paneArgs, "--entrypoint")
          if (!pluginId || !entrypoint) {
            if (!positional) {
              throw new PluginCliError(
                "pane open needs <plugin-id.pane-id> (or --plugin <id> --entrypoint <pane-id>) [--task <task-id>]",
              )
            }
            ;({ pluginId, entrypoint } = resolvePaneQualified(positional))
          }
          await openPane(pluginId, entrypoint, flagValue(paneArgs, "--task"))
          return
        }
        printUsage(process.stderr)
        process.exit(2)
        return
      }
      case "action": {
        const [sub, ...actionArgs] = args
        if (sub === "list") {
          listActions(flagValue(actionArgs, "--plugin"))
          return
        }
        if (sub === "invoke") {
          if (!actionArgs[0]) throw new PluginCliError("action invoke needs <plugin-id.action-id>")
          invokeAction(actionArgs[0], actionArgs.slice(1))
          return
        }
        printUsage(process.stderr)
        process.exit(2)
        return
      }
      default:
        printUsage(command === undefined || command === "help" ? process.stdout : process.stderr)
        if (command !== undefined && command !== "help") process.exit(2)
        return
    }
  } catch (err) {
    if (err instanceof PluginCliError) {
      console.error(`kobe plugin: ${err.message}`)
      process.exit(1)
    }
    console.error(`kobe plugin: ${errorMessage(err)}`)
    process.exit(1)
  }
}
