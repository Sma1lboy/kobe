import {
  defaultEngineCommand,
  engineCommandKey,
  engineDisplayName,
  engineNameKey,
} from "../engine/interactive-command.ts"
import { AUTO_STATUS_KEY } from "../state/auto-status.ts"
import { DISPATCHER_KEY } from "../state/dispatcher.ts"
import { loadStateFile, patchStateFile } from "../state/store.ts"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KINDS,
  EDITOR_KIND_KEY,
  normalizeEditorKind,
} from "../tui/lib/editor-prefs.ts"
import type { VendorId } from "../types/task.ts"
import { BUILTIN_VENDORS, isBuiltinVendor } from "../types/vendor.ts"

const FOCUS_ACCENTS = ["primary", "success", "info"] as const
const ENGINE_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/
const stringValue = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)
const boolValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)

function customEngineIdsFrom(state: Record<string, unknown>): string[] {
  const raw = state.customEngineIds
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === "string" && ENGINE_ID_RE.test(id) && !isBuiltinVendor(id))
}

function humanizeSlug(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function engineLabel(state: Record<string, unknown>, id: VendorId): string {
  return stringValue(state[engineNameKey(id)]).trim() || engineDisplayName(id)
}

function engineCommand(state: Record<string, unknown>, id: VendorId): string {
  return stringValue(state[engineCommandKey(id)]).trim() || defaultEngineCommand(id).join(" ")
}

export function daemonSettingsSnapshot(): Response {
  const state = loadStateFile()
  const custom = customEngineIdsFrom(state)
  const engineIds = [...BUILTIN_VENDORS, ...custom] as VendorId[]
  const defaultEngine = stringValue(state.defaultVendor, stringValue(state.lastSelectedVendor, "claude"))
  const focusAccent = stringValue(state.focusAccent, "primary")
  return Response.json({
    activeTheme: stringValue(state.activeTheme, "claude"),
    transparentBackground: boolValue(state.transparentBackground, true),
    focusAccent: FOCUS_ACCENTS.includes(focusAccent as (typeof FOCUS_ACCENTS)[number]) ? focusAccent : "primary",
    notificationsToast: state["notifications.toast.enabled"] !== false,
    notificationsSound: state["notifications.sound.enabled"] !== false,
    editorKind: normalizeEditorKind(state[EDITOR_KIND_KEY] ?? DEFAULT_EDITOR_KIND),
    editorCustomCommand: stringValue(state[EDITOR_CUSTOM_KEY]),
    remoteProjects: state["experimental.remoteProjects"] === true,
    archivedHistoryPreview: state["experimental.archivedHistoryPreview"] === true,
    autoStatus: state[AUTO_STATUS_KEY] === true,
    dispatcher: state[DISPATCHER_KEY] === true,
    defaultEngine,
    engines: engineIds.map((id) => ({
      id,
      label: engineLabel(state, id),
      command: engineCommand(state, id),
      isBuiltin: isBuiltinVendor(id),
      isCustom: !isBuiltinVendor(id),
      isDefault: id === defaultEngine,
    })),
  })
}

function putString(patch: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string") patch[key] = value.trim()
}
function putBool(patch: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "boolean") patch[key] = value
}

export async function daemonSettingsPatch(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    putString(patch, "activeTheme", body.activeTheme)
    putBool(patch, "transparentBackground", body.transparentBackground)
    if (FOCUS_ACCENTS.includes(body.focusAccent as (typeof FOCUS_ACCENTS)[number])) patch.focusAccent = body.focusAccent
    putBool(patch, "notifications.toast.enabled", body.notificationsToast)
    putBool(patch, "notifications.sound.enabled", body.notificationsSound)
    if (EDITOR_KINDS.includes(body.editorKind as (typeof EDITOR_KINDS)[number]))
      patch[EDITOR_KIND_KEY] = body.editorKind
    putString(patch, EDITOR_CUSTOM_KEY, body.editorCustomCommand)
    putBool(patch, "experimental.remoteProjects", body.remoteProjects)
    putBool(patch, "experimental.archivedHistoryPreview", body.archivedHistoryPreview)
    putBool(patch, AUTO_STATUS_KEY, body.autoStatus)
    putBool(patch, DISPATCHER_KEY, body.dispatcher)
    putString(patch, "defaultVendor", body.defaultEngine)

    const state = loadStateFile()
    const custom = customEngineIdsFrom(state)
    const known = new Set<string>([...BUILTIN_VENDORS, ...custom])
    for (const raw of Array.isArray(body.engineUpdates) ? body.engineUpdates : []) {
      if (!raw || typeof raw !== "object") continue
      const update = raw as { id?: unknown; command?: unknown; label?: unknown }
      if (typeof update.id !== "string" || !known.has(update.id)) continue
      putString(patch, engineCommandKey(update.id), update.command)
      putString(patch, engineNameKey(update.id), update.label)
    }
    if (body.addEngine && typeof body.addEngine === "object") {
      const add = body.addEngine as { id?: unknown; command?: unknown; label?: unknown }
      const id = typeof add.id === "string" ? add.id.trim().toLowerCase() : ""
      if (!ENGINE_ID_RE.test(id) || isBuiltinVendor(id) || known.has(id))
        return Response.json({ error: "invalid or duplicate engine id" }, { status: 400 })
      patch.customEngineIds = [...custom, id]
      patch[engineCommandKey(id)] = stringValue(add.command).trim()
      const label = stringValue(add.label).trim()
      patch[engineNameKey(id)] = label && label !== id ? label : humanizeSlug(id)
    }
    if (typeof body.removeEngine === "string" && !isBuiltinVendor(body.removeEngine)) {
      const id = body.removeEngine
      patch.customEngineIds = custom.filter((engine) => engine !== id)
      patch[engineCommandKey(id)] = undefined
      patch[engineNameKey(id)] = undefined
      if (state.defaultVendor === id) patch.defaultVendor = "claude"
      if (state.lastSelectedVendor === id) patch.lastSelectedVendor = "claude"
    }
    if (Object.keys(patch).length > 0) patchStateFile(patch)
    return daemonSettingsSnapshot()
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
