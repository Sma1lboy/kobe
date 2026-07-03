/**
 * GET/PATCH /api/settings — the shared TUI/web settings surface backed by
 * state.json, split out of web-server.ts verbatim (file-size cap). Owns the
 * settings snapshot shape and the patch/engine-management validation.
 */

import { defaultEngineCommand, engineCommandKey, engineDisplayName, engineNameKey } from "@/engine/interactive-command"
import { AUTO_STATUS_KEY } from "@/state/auto-status"
import { DISPATCHER_KEY } from "@/state/dispatcher"
import { loadStateFile, patchStateFile } from "@/state/store"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KINDS,
  EDITOR_KIND_KEY,
  normalizeEditorKind,
} from "@/tui/lib/editor-prefs"
import { DEFAULT_SETTINGS_SURFACE, SETTINGS_SURFACE_KEY, normalizeSettingsSurface } from "@/tui/lib/settings-surface"
import type { VendorId } from "@/types/task"
import { BUILTIN_VENDORS, isBuiltinVendor } from "@/types/vendor"

const FOCUS_ACCENTS = ["primary", "success", "info"] as const
const ENGINE_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

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

function engineLabelText(state: Record<string, unknown>, id: VendorId): string {
  const custom = stringValue(state[engineNameKey(id)]).trim()
  return custom || engineDisplayName(id)
}

function engineCommandText(state: Record<string, unknown>, id: VendorId): string {
  const custom = stringValue(state[engineCommandKey(id)]).trim()
  return custom || defaultEngineCommand(id).join(" ")
}

export function settingsSnapshot(): Response {
  const state = loadStateFile()
  const custom = customEngineIdsFrom(state)
  const engineIds = [...BUILTIN_VENDORS, ...custom] as VendorId[]
  const defaultEngine = stringValue(state.lastSelectedVendor, "claude")
  const focusAccent = stringValue(state.focusAccent, "primary")
  return Response.json({
    activeTheme: stringValue(state.activeTheme, "claude"),
    transparentBackground: boolValue(state.transparentBackground, false),
    focusAccent: FOCUS_ACCENTS.includes(focusAccent as (typeof FOCUS_ACCENTS)[number]) ? focusAccent : "primary",
    notificationsToast: state["notifications.toast.enabled"] !== false,
    notificationsSound: state["notifications.sound.enabled"] !== false,
    settingsSurface: normalizeSettingsSurface(state[SETTINGS_SURFACE_KEY] ?? DEFAULT_SETTINGS_SURFACE),
    editorKind: normalizeEditorKind(state[EDITOR_KIND_KEY] ?? DEFAULT_EDITOR_KIND),
    editorCustomCommand: stringValue(state[EDITOR_CUSTOM_KEY]),
    remoteProjects: state["experimental.remoteProjects"] === true,
    archivedHistoryPreview: state["experimental.archivedHistoryPreview"] === true,
    autoStatus: state[AUTO_STATUS_KEY] === true,
    dispatcher: state[DISPATCHER_KEY] === true,
    defaultEngine,
    engines: engineIds.map((id) => ({
      id,
      label: engineLabelText(state, id),
      command: engineCommandText(state, id),
      isBuiltin: isBuiltinVendor(id),
      isCustom: !isBuiltinVendor(id),
      isDefault: id === defaultEngine,
    })),
  })
}

function putIfString(patch: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string") patch[key] = value.trim()
}

function putIfBool(patch: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "boolean") patch[key] = value
}

export async function settingsPatch(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    putIfString(patch, "activeTheme", body.activeTheme)
    putIfBool(patch, "transparentBackground", body.transparentBackground)
    if (FOCUS_ACCENTS.includes(body.focusAccent as (typeof FOCUS_ACCENTS)[number])) {
      patch.focusAccent = body.focusAccent
    }
    putIfBool(patch, "notifications.toast.enabled", body.notificationsToast)
    putIfBool(patch, "notifications.sound.enabled", body.notificationsSound)
    if (body.settingsSurface === "chattab" || body.settingsSurface === "taskpanel") {
      patch[SETTINGS_SURFACE_KEY] = body.settingsSurface
    }
    if (EDITOR_KINDS.includes(body.editorKind as (typeof EDITOR_KINDS)[number]))
      patch[EDITOR_KIND_KEY] = body.editorKind
    putIfString(patch, EDITOR_CUSTOM_KEY, body.editorCustomCommand)
    putIfBool(patch, "experimental.remoteProjects", body.remoteProjects)
    putIfBool(patch, "experimental.archivedHistoryPreview", body.archivedHistoryPreview)
    putIfBool(patch, AUTO_STATUS_KEY, body.autoStatus)
    putIfBool(patch, DISPATCHER_KEY, body.dispatcher)
    putIfString(patch, "lastSelectedVendor", body.defaultEngine)

    const state = loadStateFile()
    const custom = customEngineIdsFrom(state)
    const known = new Set<string>([...BUILTIN_VENDORS, ...custom])

    const updates = Array.isArray(body.engineUpdates) ? body.engineUpdates : []
    for (const raw of updates) {
      if (!raw || typeof raw !== "object") continue
      const update = raw as { id?: unknown; command?: unknown; label?: unknown }
      if (typeof update.id !== "string" || !known.has(update.id)) continue
      putIfString(patch, engineCommandKey(update.id), update.command)
      putIfString(patch, engineNameKey(update.id), update.label)
    }

    if (body.addEngine && typeof body.addEngine === "object") {
      const add = body.addEngine as { id?: unknown; command?: unknown; label?: unknown }
      const id = typeof add.id === "string" ? add.id.trim().toLowerCase() : ""
      if (!ENGINE_ID_RE.test(id) || isBuiltinVendor(id) || known.has(id)) {
        return Response.json({ error: "invalid or duplicate engine id" }, { status: 400 })
      }
      patch.customEngineIds = [...custom, id]
      patch[engineCommandKey(id)] = stringValue(add.command).trim()
      const label = stringValue(add.label).trim()
      patch[engineNameKey(id)] = label && label !== id ? label : humanizeSlug(id)
    }

    if (typeof body.removeEngine === "string") {
      const id = body.removeEngine
      if (!isBuiltinVendor(id)) {
        patch.customEngineIds = custom.filter((engine) => engine !== id)
        patch[engineCommandKey(id)] = undefined
        patch[engineNameKey(id)] = undefined
        if (state.lastSelectedVendor === id) patch.lastSelectedVendor = "claude"
      }
    }

    if (Object.keys(patch).length > 0) patchStateFile(patch)
    return settingsSnapshot()
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}
