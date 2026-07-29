/**
 * `kobe-plugin.toml` — the contract between kobe and a plugin.
 *
 * A plugin is a directory with this manifest plus argv commands kobe can
 * launch; there is no plugin SDK — the whole `kobe` CLI (and the daemon
 * socket) is the plugin API. The manifest shape is deliberately isomorphic
 * to herdr's `herdr-plugin.toml` ([[build]] / [[startup]] / [[actions]] /
 * [[events]]) so porting a plugin between the two ecosystems is a rename
 * plus swapping the callback CLI. Design doc: docs/design/plugins.md.
 */

import { parse as parseToml } from "smol-toml"

export type PluginPlatform = "macos" | "linux" | "windows"

export const PLUGIN_PLATFORMS: readonly PluginPlatform[] = ["macos", "linux", "windows"]

/** Discrete plugin-facing event names — the product layer derived from
 *  daemon channels plus the normalized agent lifecycle
 *  (docs/design/plugin-events.md; see plugins/events.ts). */
export const PLUGIN_EVENT_NAMES = [
  // Product layer
  "task.created",
  "task.deleted",
  "worktree.created",
  // Reduced activity-state transitions (deduped per task+tab)
  "agent.turn-complete",
  "agent.permission-needed",
  "agent.rate-limited",
  "agent.error",
  "agent.running",
  "agent.idle",
  // Agent lifecycle (one event per engine hook report)
  "session.start",
  "session.end",
  "turn.prompt",
  "turn.complete",
  "turn.failed",
  "turn.interrupted",
  "tool.pre",
  "tool.post",
  "tool.failed",
  "attention.permission",
  "attention.question",
  "context.pre-compact",
  "context.post-compact",
  "subagent.start",
  "subagent.stop",
] as const

export type PluginEventName = (typeof PLUGIN_EVENT_NAMES)[number]

export interface PluginCommandSpec {
  /** Argv array; never run through a shell, so no expansion. */
  readonly command: readonly string[]
  /** Item-level platform override; absent → the manifest-level list. */
  readonly platforms?: readonly PluginPlatform[]
}

export interface PluginAction extends PluginCommandSpec {
  /** Local id (no dots); globally qualified as `<plugin.id>.<action.id>`. */
  readonly id: string
  readonly title: string
}

export interface PluginEventHook extends PluginCommandSpec {
  readonly on: PluginEventName
}

/** One user-tunable setting: declared here, edited in Settings → Plugins,
 *  stored as `KEY=value` in the plugin's config `.env` (the contract plugin
 *  commands already source). */
export interface PluginSetting {
  /** Env var name written to the config .env (conventionally KOBE_<PLUGIN>_*). */
  readonly key: string
  readonly label: string
  readonly type: "string" | "number" | "boolean" | "enum"
  /** Enum choices (required for type = "enum"). */
  readonly options?: readonly string[]
  /** Default shown when the .env has no value; storage is always a string. */
  readonly default?: string
}

/** Route "open this file" from the Files pane to a plugin action: the first
 *  enabled handler whose pattern matches the file name wins; the action
 *  receives the absolute path as its argument. */
export interface PluginFileHandler {
  /** JS regex source tested against the file's name/path. */
  readonly pattern: string
  /** Local action id in this plugin. */
  readonly action: string
}

export interface PluginPane extends PluginCommandSpec {
  /** Local id (no dots), like actions. */
  readonly id: string
  readonly title: string
  /** `split` (default) joins the focused chattab's split group; `tab` opens
   *  a separate self-closing command tab. */
  readonly placement: "split" | "tab"
}

export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly minKobeVersion: string
  readonly description?: string
  readonly platforms?: readonly PluginPlatform[]
  readonly build: readonly PluginCommandSpec[]
  readonly startup: readonly PluginCommandSpec[]
  readonly actions: readonly PluginAction[]
  readonly events: readonly PluginEventHook[]
  readonly panes: readonly PluginPane[]
  readonly settings: readonly PluginSetting[]
  readonly fileHandlers: readonly PluginFileHandler[]
}

export interface ParsedPluginManifest {
  readonly manifest: PluginManifest
  /** Non-fatal issues (unknown event names, missing platforms declaration). */
  readonly warnings: readonly string[]
}

export const PLUGIN_MANIFEST_FILENAME = "kobe-plugin.toml"

/** ASCII letters, digits, dot, colon, underscore, hyphen — same as herdr. */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
/** Local ids (actions): same alphabet minus dots, so qualified names split cleanly. */
const LOCAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/

export function qualifiedActionId(pluginId: string, actionId: string): string {
  return `${pluginId}.${actionId}`
}

/** Map `process.platform` onto manifest platform tokens. */
export function currentPluginPlatform(platform: NodeJS.Platform = process.platform): PluginPlatform | undefined {
  if (platform === "darwin") return "macos"
  if (platform === "linux") return "linux"
  if (platform === "win32") return "windows"
  return undefined
}

/** Whether an item (or the whole plugin) is declared to run on `platform`. */
export function supportsPlatform(
  item: { platforms?: readonly PluginPlatform[] },
  manifest: Pick<PluginManifest, "platforms">,
  platform: PluginPlatform | undefined,
): boolean {
  const declared = item.platforms ?? manifest.platforms
  if (!declared) return true
  return platform !== undefined && declared.includes(platform)
}

class ManifestError extends Error {}

function fail(message: string): never {
  throw new ManifestError(`kobe-plugin.toml: ${message}`)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`\`${field}\` must be a non-empty string`)
  return value
}

function asCommand(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.length > 0)) {
    fail(`\`${field}\` must be a non-empty array of strings (argv form)`)
  }
  return value
}

function asPlatforms(value: unknown, field: string): PluginPlatform[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((v) => (PLUGIN_PLATFORMS as readonly string[]).includes(v as string))) {
    fail(`\`${field}\` must be an array drawn from ${PLUGIN_PLATFORMS.join(", ")}`)
  }
  return value as PluginPlatform[]
}

function asTableArray(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))) {
    fail(`\`[[${field}]]\` must be an array of tables`)
  }
  return value as Record<string, unknown>[]
}

/**
 * Parse + validate manifest text. Throws with a `kobe-plugin.toml:`-prefixed
 * message on a fatal problem; collects non-fatal issues into `warnings`.
 */
export function parsePluginManifest(text: string): ParsedPluginManifest {
  let raw: Record<string, unknown>
  try {
    raw = parseToml(text)
  } catch (err) {
    fail(`invalid TOML — ${err instanceof Error ? err.message : String(err)}`)
  }
  const warnings: string[] = []

  const id = asString(raw.id, "id")
  if (!PLUGIN_ID_RE.test(id)) fail(`plugin id \`${id}\` may use ASCII letters, digits, dot, colon, underscore, hyphen`)
  const name = asString(raw.name, "name")
  const version = asString(raw.version, "version")
  const minKobeVersion = asString(raw.min_kobe_version, "min_kobe_version")
  const description = raw.description === undefined ? undefined : asString(raw.description, "description")
  const platforms = asPlatforms(raw.platforms, "platforms")
  if (!platforms) warnings.push("no top-level `platforms` declared; assuming the plugin runs everywhere")

  const build = asTableArray(raw.build, "build").map((t, i) => ({
    command: asCommand(t.command, `build[${i}].command`),
    platforms: asPlatforms(t.platforms, `build[${i}].platforms`),
  }))
  const startup = asTableArray(raw.startup, "startup").map((t, i) => ({
    command: asCommand(t.command, `startup[${i}].command`),
    platforms: asPlatforms(t.platforms, `startup[${i}].platforms`),
  }))

  const actions = asTableArray(raw.actions, "actions").map((t, i) => {
    const actionId = asString(t.id, `actions[${i}].id`)
    if (!LOCAL_ID_RE.test(actionId)) fail(`action id \`${actionId}\` may not contain dots`)
    return {
      id: actionId,
      title: asString(t.title, `actions[${i}].title`),
      command: asCommand(t.command, `actions[${i}].command`),
      platforms: asPlatforms(t.platforms, `actions[${i}].platforms`),
    }
  })
  const seen = new Set<string>()
  for (const a of actions) {
    if (seen.has(a.id)) fail(`duplicate action id \`${a.id}\``)
    seen.add(a.id)
  }

  // Panes join the focused chattab's split group by default (`split`), or
  // open a separate command tab (`tab`); herdr-style overlay/popup are
  // tolerated with a warning and treated as split.
  const panes = asTableArray(raw.panes, "panes").map((t, i) => {
    const paneId = asString(t.id, `panes[${i}].id`)
    if (!LOCAL_ID_RE.test(paneId)) fail(`pane id \`${paneId}\` may not contain dots`)
    if (t.placement !== undefined && t.placement !== "tab" && t.placement !== "split") {
      warnings.push(`pane \`${paneId}\` placement \`${String(t.placement)}\` is not supported yet; opening as a split`)
    }
    return {
      id: paneId,
      title: asString(t.title, `panes[${i}].title`),
      placement: (t.placement === "tab" ? "tab" : "split") as "split" | "tab",
      command: asCommand(t.command, `panes[${i}].command`),
      platforms: asPlatforms(t.platforms, `panes[${i}].platforms`),
    }
  })
  const paneSeen = new Set<string>()
  for (const p of panes) {
    if (paneSeen.has(p.id)) fail(`duplicate pane id \`${p.id}\``)
    paneSeen.add(p.id)
  }

  const events = asTableArray(raw.events, "events").flatMap((t, i) => {
    const on = asString(t.on, `events[${i}].on`)
    const hook = {
      on: on as PluginEventName,
      command: asCommand(t.command, `events[${i}].command`),
      platforms: asPlatforms(t.platforms, `events[${i}].platforms`),
    }
    if (!(PLUGIN_EVENT_NAMES as readonly string[]).includes(on)) {
      warnings.push(`unknown event \`${on}\`; this hook will never fire on this kobe version`)
    }
    return [hook]
  })

  const settings = asTableArray(raw.settings, "settings").map((t, i) => {
    const type = asString(t.type, `settings[${i}].type`)
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "enum") {
      fail(`settings[${i}].type must be string | number | boolean | enum`)
    }
    const options =
      t.options === undefined
        ? undefined
        : Array.isArray(t.options) && t.options.every((o) => typeof o === "string" && o.length > 0)
          ? (t.options as string[])
          : fail(`settings[${i}].options must be an array of strings`)
    if (type === "enum" && (!options || options.length === 0)) fail(`settings[${i}] enum needs \`options\``)
    return {
      key: asString(t.key, `settings[${i}].key`),
      label: asString(t.label, `settings[${i}].label`),
      type: type as "string" | "number" | "boolean" | "enum",
      ...(options ? { options } : {}),
      ...(t.default === undefined ? {} : { default: asString(t.default, `settings[${i}].default`) }),
    }
  })

  const fileHandlers = asTableArray(raw.file_handlers, "file_handlers").map((t, i) => {
    const pattern = asString(t.pattern, `file_handlers[${i}].pattern`)
    try {
      new RegExp(pattern)
    } catch {
      fail(`file_handlers[${i}].pattern is not a valid regex`)
    }
    const action = asString(t.action, `file_handlers[${i}].action`)
    if (!actions.some((a) => a.id === action)) fail(`file_handlers[${i}] names unknown action \`${action}\``)
    return { pattern, action }
  })

  return {
    manifest: {
      id,
      name,
      version,
      minKobeVersion,
      description,
      platforms,
      build,
      startup,
      actions,
      events,
      panes,
      settings,
      fileHandlers,
    },
    warnings,
  }
}
