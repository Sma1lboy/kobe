/**
 * Daemon-side plugin host: loads the registry, runs `[[startup]]` hooks once
 * the socket is ready, and fires `[[events]]` hooks off the channel bus (via
 * PluginEventReducer). Every run is appended to the plugin's `log.jsonl`.
 *
 * Plugins are ordinary argv commands — no shell, cwd = plugin root, env
 * carries the KOBE_PLUGIN_* contract (docs/design/plugins.md). The host
 * file-watches `plugins.json` so a CLI install/link/enable applies to the
 * running daemon without a restart. Startup hooks run only at daemon start
 * (herdr semantics): a reload swaps hook registrations, nothing more.
 */

import { spawn } from "node:child_process"
import { type FSWatcher, appendFileSync, mkdirSync, readFileSync, watch } from "node:fs"
import { dirname } from "node:path"
import type { ChannelEvent } from "../daemon/event-bus.ts"
import { buildPluginEnv } from "./env.ts"
import { type PluginEvent, PluginEventReducer } from "./events.ts"
import {
  PLUGIN_MANIFEST_FILENAME,
  type PluginCommandSpec,
  type PluginManifest,
  currentPluginPlatform,
  parsePluginManifest,
  supportsPlatform,
} from "./manifest.ts"
import { pluginConfigDir, pluginLogPath, pluginRegistryPath, pluginStateDir } from "./plugin-paths.ts"
import { loadPluginRegistry } from "./registry.ts"

export interface PluginHostOptions {
  readonly homeDir?: string
  readonly socketPath: string
  /** Path plugins should exec to call back into kobe (packaged `kobe` on PATH, or a dev override). */
  readonly binPath: string
  readonly log?: (line: string) => void
}

interface LoadedPlugin {
  readonly manifest: PluginManifest
  readonly root: string
}

const OUTPUT_CAP = 8 * 1024
const RELOAD_DEBOUNCE_MS = 150

/** Compose a host onto the daemon's bus: subscribe first, then start. */
export function startPluginHost(
  bus: { onPublish(sink: (event: ChannelEvent) => void): () => void },
  opts: PluginHostOptions,
): PluginHost {
  const host = new PluginHost(opts)
  bus.onPublish((event) => host.handleChannel(event))
  host.start()
  return host
}

export class PluginHost {
  private readonly opts: PluginHostOptions
  private readonly reducer = new PluginEventReducer()
  private plugins: LoadedPlugin[] = []
  private watcher: FSWatcher | undefined
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(opts: PluginHostOptions) {
    this.opts = opts
  }

  /** Load the registry, run startup hooks, and begin watching for changes. */
  start(): void {
    this.plugins = this.loadPlugins()
    for (const plugin of this.plugins) {
      for (const [i, hook] of plugin.manifest.startup.entries()) {
        if (!supportsPlatform(hook, plugin.manifest, currentPluginPlatform())) continue
        void this.run(plugin, hook, "startup", { KOBE_PLUGIN_EVENT: "startup" }, `startup[${i}]`)
      }
    }
    this.watchRegistry()
  }

  stop(): void {
    this.stopped = true
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.watcher?.close()
  }

  /** Feed every bus publish through here (server wires `bus.onPublish`). */
  handleChannel(event: ChannelEvent): void {
    if (this.stopped) return
    for (const derived of this.reducer.reduce(event)) this.dispatch(derived)
  }

  private dispatch(event: PluginEvent): void {
    const platform = currentPluginPlatform()
    for (const plugin of this.plugins) {
      for (const hook of plugin.manifest.events) {
        if (hook.on !== event.event) continue
        if (!supportsPlatform(hook, plugin.manifest, platform)) continue
        // Task id/title also ride as plain env vars so shell plugins don't
        // need a JSON parser for the common case.
        void this.run(
          plugin,
          hook,
          "event",
          {
            KOBE_PLUGIN_EVENT: event.event,
            KOBE_PLUGIN_EVENT_JSON: JSON.stringify(event),
            ...(event.taskId ? { KOBE_PLUGIN_TASK_ID: event.taskId } : {}),
            ...(event.task?.title ? { KOBE_PLUGIN_TASK_TITLE: event.task.title } : {}),
          },
          hook.on,
        )
      }
    }
  }

  private loadPlugins(): LoadedPlugin[] {
    const registry = loadPluginRegistry(this.opts.homeDir)
    const platform = currentPluginPlatform()
    const out: LoadedPlugin[] = []
    for (const entry of registry.plugins) {
      if (!entry.enabled) continue
      let manifest: PluginManifest
      try {
        const text = readFileSync(`${entry.root}/${PLUGIN_MANIFEST_FILENAME}`, "utf8")
        manifest = parsePluginManifest(text).manifest
      } catch (err) {
        this.opts.log?.(`plugin ${entry.id}: manifest unreadable, skipping — ${String(err)}`)
        continue
      }
      if (!supportsPlatform({}, manifest, platform)) continue
      out.push({ manifest, root: entry.root })
    }
    return out
  }

  private watchRegistry(): void {
    const path = pluginRegistryPath(this.opts.homeDir)
    try {
      mkdirSync(dirname(path), { recursive: true })
      // Watch the directory: plugins.json may not exist yet, and whole-file
      // rewrites replace the inode on some platforms.
      this.watcher = watch(dirname(path), (_kind, filename) => {
        if (filename && filename !== "plugins.json") return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          if (this.stopped) return
          this.plugins = this.loadPlugins()
          this.opts.log?.(`plugin registry reloaded (${this.plugins.length} enabled)`)
        }, RELOAD_DEBOUNCE_MS)
      })
    } catch (err) {
      this.opts.log?.(`plugin registry watch failed — ${String(err)}`)
    }
  }

  private async run(
    plugin: LoadedPlugin,
    spec: PluginCommandSpec,
    kind: "startup" | "event",
    extraEnv: Record<string, string>,
    label: string,
  ): Promise<void> {
    const id = plugin.manifest.id
    const startedAt = Date.now()
    mkdirSync(pluginConfigDir(id, this.opts.homeDir), { recursive: true })
    mkdirSync(pluginStateDir(id, this.opts.homeDir), { recursive: true })
    let exitCode: number | null = null
    let stdout = ""
    let stderr = ""
    let spawnError: string | undefined
    await new Promise<void>((resolve) => {
      const [cmd, ...args] = spec.command
      const child = spawn(cmd as string, args, {
        cwd: plugin.root,
        env: buildPluginEnv({
          homeDir: this.opts.homeDir,
          socketPath: this.opts.socketPath,
          binPath: this.opts.binPath,
          pluginId: plugin.manifest.id,
          pluginRoot: plugin.root,
          extra: extraEnv,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += chunk.toString().slice(0, OUTPUT_CAP - stdout.length)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += chunk.toString().slice(0, OUTPUT_CAP - stderr.length)
      })
      child.on("error", (err) => {
        spawnError = String(err)
        resolve()
      })
      child.on("close", (code) => {
        exitCode = code
        resolve()
      })
    })
    const record = {
      at: startedAt,
      kind,
      label,
      command: spec.command,
      exitCode,
      durationMs: Date.now() - startedAt,
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      ...(spawnError ? { spawnError } : {}),
    }
    try {
      appendFileSync(pluginLogPath(id, this.opts.homeDir), `${JSON.stringify(record)}\n`)
    } catch {
      // Log write failure must never take the daemon down.
    }
    if (spawnError || (exitCode !== null && exitCode !== 0)) {
      this.opts.log?.(`plugin ${id} ${label}: ${spawnError ?? `exit ${exitCode}`}`)
    }
  }
}
