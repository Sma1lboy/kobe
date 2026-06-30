/**
 * i18n message catalog — the per-namespace message files composed into one
 * `en` / `zh` tree.
 *
 * English (`en`) is the SOURCE OF TRUTH: it defines the `Messages` shape every
 * other locale must satisfy. `zh` (简体中文) must carry the exact same key set —
 * `bun run check-i18n` and `test/tui/i18n-catalog.test.ts` (CI) fail on any
 * missing/extra key or dropped `{placeholder}` so the two never drift.
 *
 * Each surface owns its own file under `./messages/` (settings, tasks, files,
 * …) so translation work parallelizes without colliding. Pure data, zero
 * runtime deps — safe under node / vitest (the reactive `t()` lives in
 * `./index.ts`, which pulls solid-js). Values may contain `{name}`
 * placeholders; `t(key, params)` substitutes them.
 *
 * We translate prose; literal config syntax (YAML keys, shell command
 * examples) is left in the calling code as-is — it isn't language.
 */

import { en as common, zh as commonZh } from "./messages/common"
import { en as files, zh as filesZh } from "./messages/files"
import { en as help, zh as helpZh } from "./messages/help"
import { en as history, zh as historyZh } from "./messages/history"
import { en as keys, zh as keysZh } from "./messages/keys"
import { en as newTask, zh as newTaskZh } from "./messages/newTask"
import { en as ops, zh as opsZh } from "./messages/ops"
import { en as quickTask, zh as quickTaskZh } from "./messages/quickTask"
import { en as settings, zh as settingsZh } from "./messages/settings"
import { en as tasks, zh as tasksZh } from "./messages/tasks"
import { en as update, zh as updateZh } from "./messages/update"

export const en = { settings, tasks, files, newTask, ops, update, quickTask, help, history, common, keys }

/**
 * Every locale must structurally match the English source of truth. The
 * namespace `zh` files are each typed `typeof en`, so the assembled tree is
 * structurally identical and this annotation just documents the contract.
 */
export type Messages = typeof en

export const zh: Messages = {
  settings: settingsZh,
  tasks: tasksZh,
  files: filesZh,
  newTask: newTaskZh,
  ops: opsZh,
  update: updateZh,
  quickTask: quickTaskZh,
  help: helpZh,
  history: historyZh,
  common: commonZh,
  keys: keysZh,
}

/** Registered locales, in display order. */
export const LOCALES = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
] as const

export type LocaleId = (typeof LOCALES)[number]["id"]

export const CATALOGS: Record<LocaleId, Messages> = { en, zh }

export const DEFAULT_LOCALE: LocaleId = "en"

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && LOCALES.some((l) => l.id === value)
}
