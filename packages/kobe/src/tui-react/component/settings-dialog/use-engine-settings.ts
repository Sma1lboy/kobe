import { useState } from "react"
import {
  VENDOR_LABEL,
  defaultEngineCommand,
  engineCommandKey,
  engineNameKey,
} from "../../../engine/interactive-command"
import { getGlobalDefaultVendor, setGlobalDefaultVendor } from "../../../state/vendor-prefs"
import { humanizeSlug } from "../../../tui/component/settings-dialog/model"
import { DEFAULT_TASK_VENDOR, type VendorId } from "../../../types/task"
import { ALL_VENDORS, isBuiltinVendor } from "../../../types/vendor"
import type { KVContext } from "../../context/kv"
import type { DialogContext } from "../../ui/dialog"
import { RenameTaskDialog } from "../rename-task-dialog"

export function useEngineSettings(
  kv: KVContext,
  dialog: DialogContext,
  onEngineListShrunk: (maxIndex: number) => void,
) {
  function customEngines(): string[] {
    const raw = kv.get("customEngineIds", [])
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : []
  }
  function engineList(): VendorId[] {
    return [...ALL_VENDORS, ...customEngines()]
  }
  function engineOverride(vendor: VendorId): string {
    const v = kv.get(engineCommandKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineCommandText(vendor: VendorId): string {
    return engineOverride(vendor) || defaultEngineCommand(vendor).join(" ")
  }
  function engineIsDefault(vendor: VendorId): boolean {
    return isBuiltinVendor(vendor) && engineOverride(vendor).length === 0 && !engineNameIsCustom(vendor)
  }
  function engineNameOverride(vendor: VendorId): string {
    const v = kv.get(engineNameKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineNameIsCustom(vendor: VendorId): boolean {
    return engineNameOverride(vendor).length > 0
  }
  function engineName(vendor: VendorId): string {
    return engineNameOverride(vendor) || VENDOR_LABEL[vendor] || vendor
  }

  const [defaultEngine, setDefaultEngineState] = useState<VendorId>(
    () => getGlobalDefaultVendor() ?? DEFAULT_TASK_VENDOR,
  )
  function setEngineDefault(vendor: VendorId): void {
    setGlobalDefaultVendor(vendor)
    kv.set("defaultVendor", vendor)
    setDefaultEngineState(vendor)
  }

  async function editEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineCommandText(vendor), {
      dialogTitle: `${engineName(vendor)} launch command`,
      fieldLabel: "command",
      submitLabel: "save",
      allowEmpty: true,
    })
    if (next === undefined) return
    kv.set(engineCommandKey(vendor), next.trim())
  }
  async function renameEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineName(vendor), {
      dialogTitle: `${engineName(vendor)} display name (blank = default)`,
      fieldLabel: "name",
      submitLabel: "save",
      allowEmpty: true,
    })
    if (next === undefined) return
    kv.set(engineNameKey(vendor), next.trim())
  }
  function resetEngine(vendor: VendorId): void {
    kv.set(engineCommandKey(vendor), "")
    kv.set(engineNameKey(vendor), "")
    if (!isBuiltinVendor(vendor)) {
      kv.set(
        "customEngineIds",
        customEngines().filter((id) => id !== vendor),
      )
      onEngineListShrunk(engineList().length)
    }
  }
  async function addEngineFlow(): Promise<void> {
    const idRaw = await RenameTaskDialog.show(dialog, "", {
      dialogTitle: "Add engine",
      fieldLabel: "id",
      submitLabel: "next",
      placeholder: "lowercase slug, e.g. aider",
    })
    if (idRaw === undefined) return
    const id = idRaw.trim().toLowerCase()
    if (!id || isBuiltinVendor(id) || customEngines().includes(id)) return
    const command = await RenameTaskDialog.show(dialog, "", {
      dialogTitle: `Add engine · ${id}`,
      fieldLabel: "command",
      submitLabel: "next",
      placeholder: "e.g. aider --model sonnet",
    })
    if (command === undefined) return
    const name = await RenameTaskDialog.show(dialog, id, {
      dialogTitle: `Add engine · ${id}`,
      fieldLabel: "name",
      submitLabel: "add",
      allowEmpty: true,
    })
    kv.set("customEngineIds", [...customEngines(), id])
    if (command.trim()) kv.set(engineCommandKey(id), command.trim())
    const typedName = name?.trim() ?? ""
    kv.set(engineNameKey(id), typedName && typedName !== id ? typedName : humanizeSlug(id))
  }

  return {
    engineList,
    engineName,
    engineCommandText,
    engineIsDefault,
    defaultEngine,
    setEngineDefault,
    editEngine,
    renameEngine,
    resetEngine,
    addEngineFlow,
  }
}
