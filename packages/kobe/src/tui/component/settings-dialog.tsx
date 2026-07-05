/**
 * Settings dialog — two-column layout with a left sidebar (sections)
 * and a right pane (the active section's content).
 *
 * Bindings inside the dialog:
 *   - `↑` / `↓` / `j` / `k` — navigate the current level.
 *   - `h` / `l`              — switch sidebar/body levels.
 *   - `enter`                — activate the focused row.
 *   - `esc`                  — close (handled by the dialog stack).
 */

import { accessSync, constants as fsConstants, mkdirSync } from "node:fs"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator"
import {
  type ClaudeAccount,
  type CodexAccount,
  type CopilotAccount,
  type EngineAccountStatus,
  detectClaudeAccount,
  detectCodexAccount,
  detectCopilotAccount,
} from "../../engine/account-detect"
import { VENDOR_LABEL, defaultEngineCommand, engineCommandKey, engineNameKey } from "../../engine/interactive-command"
import { submitFeedback } from "../../lib/feedback"
import { ARCHIVED_HISTORY_PREVIEW_KEY } from "../../state/archived-history"
import { AUTO_STATUS_KEY } from "../../state/auto-status"
import { DISPATCHER_KEY } from "../../state/dispatcher"
import { getPersistedString, setPersistedString } from "../../state/repos"
import {
  PROJECT_DIR_TOKEN,
  PROJECT_SIBLING_BASE,
  WORKTREE_BASE_CUSTOM_KEY,
  WORKTREE_BASE_KEY,
  type WorktreeBaseKind,
  hasProjectDirToken,
  normalizeWorktreeBase,
  worktreeBaseKindOf,
} from "../../state/worktree-base"
import { ZEN_KEEP_TASKS_KEY } from "../../state/zen"
import type { VendorId } from "../../types/task"
import { ALL_VENDORS, isBuiltinVendor, resolvePersistedVendor } from "../../types/vendor"
import type { KVContext } from "../context/kv"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, useTheme } from "../context/theme"
import { type LocaleId, currentLang, setLocaleLang, t } from "../i18n"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KINDS,
  EDITOR_KIND_KEY,
  type EditorKind,
  normalizeEditorKind,
} from "../lib/editor-prefs"
import { useBindings } from "../lib/keymap"
import { LOCALE_KEY } from "../lib/persisted-ui-prefs"
import {
  DEFAULT_SETTINGS_SURFACE,
  SETTINGS_SURFACE_KEY,
  type SettingsSurface,
  normalizeSettingsSurface,
} from "../lib/settings-surface"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { RenameTaskDialog } from "./rename-task-dialog"
import { confirmResetState, confirmRestartDaemon, hasRestartableDaemon } from "./settings-dialog/actions"
import { type NavLevel, SECTIONS, type SectionId, type SettingsRow, rowAt, sectionRows } from "./settings-dialog/model"
import {
  AccountsSettingsSection,
  DevSettingsSection,
  EngineSettingsSection,
  FeedbackSettingsSection,
  GeneralSettingsSection,
  KeybindingsSettingsSection,
  SettingsSectionSidebar,
} from "./settings-dialog/sections"

/**
 * Turn a custom-engine slug into a presentable display name: split on `-`/`_`
 * and title-case each word. `my-local-agent` → `My Local Agent`, `aider` →
 * `Aider`. Used so a custom engine added with no name still reads like the
 * title-cased built-ins instead of its raw lowercase-hyphenated id.
 */
function humanizeSlug(id: string): string {
  return id
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export type SettingsDialogProps = {
  kv: KVContext
  /**
   * The active orchestrator. Used to expose the "Restart backend" Dev
   * button only when we're attached to a daemon (RemoteOrchestrator).
   */
  orchestrator?: KobeOrchestrator
  onVisualPrefsChange?: () => void
  onClose: () => void
  /**
   * True when this dialog is the standalone page surface (`kobe settings`),
   * rendered OUTSIDE the dialog stack rather than pushed onto it. The page
   * mounts this component permanently, so when it opens a sub-dialog (the
   * engine-command / custom-editor text input) this component stays mounted
   * underneath. Without a guard its `j/k/l/h/t` navigation bindings would
   * keep firing and swallow those letters from the text input (the `{file}`
   * "l-is-eaten" bug). When standalone we therefore disable our own key
   * bindings whenever the dialog stack is non-empty — mirroring the page's
   * own esc/q guard. In the overlay surface this dialog IS the stack entry
   * and unmounts when a sub-dialog replaces it, so no guard is needed.
   */
  standalone?: boolean
}

export function SettingsDialog(props: SettingsDialogProps) {
  const dialog = useDialog()
  const themeCtx = useTheme()
  const renderer = useRenderer()
  const { theme } = themeCtx
  const [level, setLevel] = createSignal<NavLevel>("sidebar")
  const [section, setSection] = createSignal<SectionId>("general")
  const [cursor, setCursor] = createSignal(0)
  const [bodyRow, setBodyRow] = createSignal(0)
  const [feedbackTitle, setFeedbackTitle] = createSignal("")
  const [feedbackBody, setFeedbackBody] = createSignal("")
  const [feedbackStatus, setFeedbackStatus] = createSignal("")
  const themeNames = createMemo<readonly string[]>(() => themeCtx.all().slice().sort())
  const [, setThemeCursor] = createSignal(
    Math.max(
      0,
      themeNames().findIndex((n) => n === themeCtx.selected),
    ),
  )
  const hasDaemon = hasRestartableDaemon(props.orchestrator)

  // Account detection (KOB-249): read-only fs/env probes, lazily run the
  // first time the Accounts section is opened so a settings open that
  // never visits it pays nothing.
  const [claudeStatus, setClaudeStatus] = createSignal<EngineAccountStatus<ClaudeAccount> | null>(null)
  const [codexStatus, setCodexStatus] = createSignal<EngineAccountStatus<CodexAccount> | null>(null)
  const [copilotStatus, setCopilotStatus] = createSignal<EngineAccountStatus<CopilotAccount> | null>(null)
  let accountsProbed = false
  createEffect(() => {
    if (section() !== "accounts" || accountsProbed) return
    accountsProbed = true
    void detectClaudeAccount().then(setClaudeStatus)
    void detectCodexAccount().then(setCodexStatus)
    void detectCopilotAccount().then(setCopilotStatus)
  })

  /**
   * The active section's ordered navigable rows (the row registry). A
   * row's body index is its position here — recomputed per call, like
   * the old count helpers, so kv-driven changes (custom engines) are
   * always fresh in key handlers.
   */
  function bodyRows(): SettingsRow[] {
    return sectionRows(section(), {
      themeNames: themeNames(),
      focusAccentSlots: FOCUS_ACCENT_SLOTS,
      engineList: engineList(),
      hasDaemon,
    })
  }

  function bodyRowCount(): number {
    return bodyRows().length
  }

  function settingsSurface(): SettingsSurface {
    return normalizeSettingsSurface(props.kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
  }

  function selectTheme(name: string): void {
    if (themeCtx.selected === name) return
    if (!themeCtx.set(name)) return
    props.kv.set("activeTheme", name)
    props.onVisualPrefsChange?.()
  }

  // UI language. Live within this process (setLocaleLang updates the module
  // store → every t() re-renders) and persisted so other panes pick it up on
  // their next boot, mirroring how the theme is applied + persisted.
  function currentLocale(): LocaleId {
    return currentLang()
  }

  function selectLanguage(locale: LocaleId): void {
    if (currentLang() === locale) return
    setLocaleLang(locale)
    props.kv.set(LOCALE_KEY, locale)
    props.onVisualPrefsChange?.()
  }

  function setTransparentBackground(next: boolean): void {
    if (themeCtx.transparentBackground === next) return
    themeCtx.setTransparentBackground(next)
    props.kv.set("transparentBackground", next)
    props.onVisualPrefsChange?.()
  }

  function toggleTransparent(): void {
    setTransparentBackground(!themeCtx.transparentBackground)
  }

  function selectFocusAccent(slot: FocusAccentSlot): void {
    if (themeCtx.focusAccent === slot) return
    themeCtx.setFocusAccent(slot)
    props.kv.set("focusAccent", slot)
    props.onVisualPrefsChange?.()
  }

  function selectSurface(surface: SettingsSurface): void {
    props.kv.set(SETTINGS_SURFACE_KEY, surface)
  }

  function toastEnabled(): boolean {
    return (props.kv.get("notifications.toast.enabled", true) as boolean) !== false
  }

  function soundEnabled(): boolean {
    return (props.kv.get("notifications.sound.enabled", true) as boolean) !== false
  }

  function toggleToast(): void {
    props.kv.set("notifications.toast.enabled", !toastEnabled())
  }

  function toggleSound(): void {
    props.kv.set("notifications.sound.enabled", !soundEnabled())
  }

  // Zen mode: whether collapsing to the engine pane keeps the Tasks rail.
  // Default on — see state/zen.ts.
  function zenKeepsTasks(): boolean {
    return props.kv.get(ZEN_KEEP_TASKS_KEY, true) !== false
  }

  function toggleZenKeepsTasks(): void {
    props.kv.set(ZEN_KEEP_TASKS_KEY, !zenKeepsTasks())
  }

  // Experimental: SSH-backed remote projects (off by default). Gates
  // `kobe add --remote`; see docs/design/remote-projects.md.
  function remoteProjectsEnabled(): boolean {
    return props.kv.get("experimental.remoteProjects", false) === true
  }

  function toggleRemoteProjects(): void {
    props.kv.set("experimental.remoteProjects", !remoteProjectsEnabled())
  }

  // Experimental: auto status flow (off by default) — turn-start moves a
  // backlog task to in_progress, and claude launches get the status
  // self-report protocol injected. See docs/design/web-kanban.md M5.
  function autoStatusOn(): boolean {
    return props.kv.get(AUTO_STATUS_KEY, false) === true
  }

  function toggleAutoStatus(): void {
    props.kv.set(AUTO_STATUS_KEY, !autoStatusOn())
  }

  // Experimental: field-notes dispatcher (off by default) — task sessions
  // file one-line gotchas, the repo's main session (injected with the
  // dispatcher protocol) relays them to the tasks that benefit. See
  // docs/design/dispatcher.md.
  function dispatcherOn(): boolean {
    return props.kv.get(DISPATCHER_KEY, false) === true
  }

  function toggleDispatcher(): void {
    props.kv.set(DISPATCHER_KEY, !dispatcherOn())
  }

  // Experimental (beta): archived-task history preview (off by default) —
  // opening an archived task shows a read-only `kobe history` pane in the
  // engine slot instead of relaunching the engine. Shared with the web
  // dashboard via the same state.json key.
  function archivedHistoryOn(): boolean {
    return props.kv.get(ARCHIVED_HISTORY_PREVIEW_KEY, false) === true
  }

  function toggleArchivedHistory(): void {
    props.kv.set(ARCHIVED_HISTORY_PREVIEW_KEY, !archivedHistoryOn())
  }

  // Engines section: per-vendor launch command. Stored in the shared
  // state.json under engineCommandKey via kv (reactive here; read
  // cross-process by interactiveEngineCommand). Empty override = default.
  //
  // The row list is the three built-ins PLUS the user's custom engines
  // (customEngineIds registry); custom engines reuse the SAME engineCommand.
  // <id> / engineName.<id> keys as built-ins, so editEngine/renameEngine work
  // for them unchanged. A trailing "+ Add engine" row (index === engineList
  // length) registers a new one.
  function customEngines(): string[] {
    const raw = props.kv.get("customEngineIds", [])
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : []
  }
  function engineList(): VendorId[] {
    return [...ALL_VENDORS, ...customEngines()]
  }
  function engineOverride(vendor: VendorId): string {
    const v = props.kv.get(engineCommandKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineCommandText(vendor: VendorId): string {
    return engineOverride(vendor) || defaultEngineCommand(vendor).join(" ")
  }
  function engineIsDefault(vendor: VendorId): boolean {
    // Custom engines have no built-in default, so they never read as "(default)".
    return isBuiltinVendor(vendor) && engineOverride(vendor).length === 0 && !engineNameIsCustom(vendor)
  }
  // Custom display name override (engineName.<vendor>), empty = VENDOR_LABEL / id.
  function engineNameOverride(vendor: VendorId): string {
    const v = props.kv.get(engineNameKey(vendor), "")
    return typeof v === "string" ? v.trim() : ""
  }
  function engineNameIsCustom(vendor: VendorId): boolean {
    return engineNameOverride(vendor).length > 0
  }
  function engineName(vendor: VendorId): string {
    // Built-ins fall back to VENDOR_LABEL; a custom engine falls back to its id.
    return engineNameOverride(vendor) || VENDOR_LABEL[vendor] || vendor
  }
  // The DEFAULT engine for new tasks — the single `lastSelectedVendor` reference
  // the new-task dialog / quick-task read and Ctrl+Shift+T writes. Read fresh on
  // open (getPersistedString) so a default set via Ctrl+Shift+T in another
  // process is reflected here; `d` on an engine row sets it (the ● marker).
  const [defaultEngine, setDefaultEngineSig] = createSignal<VendorId>(
    resolvePersistedVendor(getPersistedString("lastSelectedVendor"), customEngines()),
  )
  function isDefaultEngine(vendor: VendorId): boolean {
    return defaultEngine() === vendor
  }
  function setEngineDefault(vendor: VendorId): void {
    setPersistedString("lastSelectedVendor", vendor)
    props.kv.set("lastSelectedVendor", vendor) // keep the in-process kv consistent
    setDefaultEngineSig(vendor)
  }
  async function editEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineCommandText(vendor), {
      dialogTitle: `${engineName(vendor)} launch command`,
      fieldLabel: "command",
      submitLabel: "save",
      allowEmpty: true, // blank clears the override → built-in default
    })
    if (next === undefined) return
    props.kv.set(engineCommandKey(vendor), next.trim())
  }
  async function renameEngine(vendor: VendorId): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, engineName(vendor), {
      dialogTitle: `${engineName(vendor)} display name (blank = default)`,
      fieldLabel: "name",
      submitLabel: "save",
      allowEmpty: true, // blank clears the name override → default label
    })
    if (next === undefined) return
    props.kv.set(engineNameKey(vendor), next.trim())
  }
  // `x` on an engine row. Built-in → reset its command + name overrides to the
  // default (clearing the keys; empty = default, no sentinel). Custom → REMOVE
  // it entirely (drop from the registry + clear its keys). Apply sites pick the
  // change up automatically (cross-process via the cleared/removed keys).
  function resetEngine(vendor: VendorId): void {
    props.kv.set(engineCommandKey(vendor), "")
    props.kv.set(engineNameKey(vendor), "")
    if (!isBuiltinVendor(vendor)) {
      props.kv.set(
        "customEngineIds",
        customEngines().filter((id) => id !== vendor),
      )
      // Keep the cursor in range after the list shrinks.
      setBodyRow((r) => Math.max(0, Math.min(r, engineList().length)))
    }
  }
  // The "+ Add engine" row: collect id + launch command + display name and
  // register a new custom engine. Reuses RenameTaskDialog for each field.
  async function addEngineFlow(): Promise<void> {
    const idRaw = await RenameTaskDialog.show(dialog, "", {
      dialogTitle: "Add engine",
      fieldLabel: "id",
      submitLabel: "next",
      placeholder: "lowercase slug, e.g. aider",
    })
    if (idRaw === undefined) return
    const id = idRaw.trim().toLowerCase()
    if (!id || isBuiltinVendor(id) || customEngines().includes(id)) return // no blank / shadow / dup
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
      allowEmpty: true, // blank = humanized id (e.g. my-local-agent → My Local Agent)
    })
    props.kv.set("customEngineIds", [...customEngines(), id])
    if (command.trim()) props.kv.set(engineCommandKey(id), command.trim())
    // A typed name wins; otherwise (blank or left as the raw id) seed a
    // humanized form so the chip reads "My Local Agent", not "my-local-agent".
    const typedName = name?.trim() ?? ""
    props.kv.set(engineNameKey(id), typedName && typedName !== id ? typedName : humanizeSlug(id))
  }
  /** The engine row under the body cursor, or null on the "+ Add engine" row / off-section. */
  function currentEngineRow(): VendorId | null {
    if (section() !== "engines" || level() !== "body") return null
    const row = rowAt(bodyRows(), bodyRow())
    return row?.kind === "engine" ? row.vendor : null
  }

  // Editor preference: which editor the file tree's `e` key launches.
  // `editor.kind` cycles auto → vim → nvim → nano → emacs → custom on enter
  // (auto, the default, follows $VISUAL/$EDITOR then auto-detects); the custom
  // command is a free-text field (reused RenameTaskDialog) used only when
  // kind === "custom". Read cross-process by tmux/editor-launch.
  function editorKind(): EditorKind {
    return normalizeEditorKind(props.kv.get(EDITOR_KIND_KEY, DEFAULT_EDITOR_KIND))
  }
  function cycleEditorKind(): void {
    const i = EDITOR_KINDS.indexOf(editorKind())
    const next = EDITOR_KINDS[(i + 1) % EDITOR_KINDS.length]
    if (next) props.kv.set(EDITOR_KIND_KEY, next)
  }
  function editorCustomCommand(): string {
    const v = props.kv.get(EDITOR_CUSTOM_KEY, "")
    return typeof v === "string" ? v : ""
  }
  async function editEditorCustom(): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, editorCustomCommand(), {
      dialogTitle: "Custom editor command (use {file} for the path)",
      fieldLabel: "command",
      submitLabel: "save",
      allowEmpty: true,
    })
    if (next === undefined) return
    const cmd = next.trim()
    props.kv.set(EDITOR_CUSTOM_KEY, cmd)
    // If the user bothered to type a command here, they want it used —
    // flip the kind to `custom` so it actually takes effect. Without this,
    // a command typed while kind is still `vim` is silently ignored (you'd
    // set `code -w` / `nano` and still get vim), which reads as a bug.
    if (cmd) props.kv.set(EDITOR_KIND_KEY, "custom")
  }

  // Worktree location: a global override for where new LOCAL task
  // worktrees are created (default `~/.kobe/worktrees`). A preset cycle
  // mirroring the editor rows — default / next to project / custom —
  // so the common choice ("beside each repo") never requires typing the
  // $project_dir token; custom is a free-text path that still accepts
  // it. The daemon's worktree path resolver (state/worktree-base.ts)
  // reads WORKTREE_BASE_KEY alone; the companion custom key only
  // remembers the last typed path across cycles.
  function worktreeBasePath(): string {
    const v = props.kv.get(WORKTREE_BASE_KEY, "")
    return typeof v === "string" ? v : ""
  }
  const worktreeKind = (): WorktreeBaseKind => worktreeBaseKindOf(worktreeBasePath())
  function worktreeKindLabel(): string {
    const kind = worktreeKind()
    if (kind === "default") return t("settings.general.worktreeKindDefault")
    if (kind === "nextToProject") return t("settings.general.worktreeKindNext")
    return t("settings.general.worktreeKindCustom")
  }
  function worktreeCustomPath(): string {
    const v = props.kv.get(WORKTREE_BASE_CUSTOM_KEY, "")
    const remembered = typeof v === "string" ? v.trim() : ""
    // A custom path saved before the preset cycle existed lives only in
    // the base key — surface it so the row isn't misleadingly "(unset)".
    return remembered || (worktreeKind() === "custom" ? worktreeBasePath().trim() : "")
  }
  function cycleWorktreeBase(): void {
    const kind = worktreeKind()
    if (kind === "default") {
      props.kv.set(WORKTREE_BASE_KEY, PROJECT_SIBLING_BASE)
    } else if (kind === "nextToProject") {
      // No remembered custom path → nothing to cycle onto; back to default.
      props.kv.set(WORKTREE_BASE_KEY, worktreeCustomPath())
    } else {
      props.kv.set(WORKTREE_BASE_CUSTOM_KEY, worktreeBasePath().trim())
      props.kv.set(WORKTREE_BASE_KEY, "")
    }
  }
  async function editWorktreeCustom(): Promise<void> {
    const next = await RenameTaskDialog.show(dialog, worktreeCustomPath(), {
      dialogTitle: t("settings.general.worktreeBaseTitle"),
      fieldLabel: t("settings.general.worktreeBaseField"),
      submitLabel: "save",
      placeholder: `${PROJECT_DIR_TOKEN}/../worktrees`,
      allowEmpty: true,
    })
    if (next === undefined) return
    const raw = next.trim()
    // A non-empty override must point at a directory kobe can actually
    // create worktrees under — otherwise every future `git worktree add`
    // fails with a raw git error and new-task creation breaks silently.
    // Validate here (create + writability check) and refuse to save a bad
    // path, rather than persisting a footgun. Blank clears the override.
    // A `$project_dir` path resolves per-project at task creation (parents
    // are mkdirp'd there), so it can't be probed globally — only its shape
    // is checked: the token must be the leading segment to expand at all.
    if (raw.includes(PROJECT_DIR_TOKEN)) {
      if (!hasProjectDirToken(raw)) {
        await DialogConfirm.show(
          dialog,
          "Can't use that worktree location",
          `${PROJECT_DIR_TOKEN} only expands as the leading path segment (e.g. ${PROJECT_DIR_TOKEN}/../kobe-worktrees). Keeping the previous setting.`,
          "cancel",
        )
        return
      }
    } else if (raw) {
      const resolved = normalizeWorktreeBase(raw) ?? raw
      try {
        mkdirSync(resolved, { recursive: true })
        accessSync(resolved, fsConstants.W_OK)
      } catch (err) {
        await DialogConfirm.show(
          dialog,
          "Can't use that worktree location",
          `${resolved} isn't usable (${err instanceof Error ? err.message : String(err)}). Keeping the previous setting — pick a writable directory.`,
          "cancel",
        )
        return
      }
    }
    // Persist the trimmed raw entry; the daemon expands ~ / relative /
    // $project_dir paths the same way when it reads it. Typing a path
    // here means the user wants it used — flip the preset to custom
    // (mirrors the editor-custom flow); blank clears the custom choice.
    props.kv.set(WORKTREE_BASE_CUSTOM_KEY, raw)
    if (raw) props.kv.set(WORKTREE_BASE_KEY, raw)
    else if (worktreeKind() === "custom") props.kv.set(WORKTREE_BASE_KEY, "")
  }

  async function sendFeedback(): Promise<void> {
    setFeedbackStatus("submitting...")
    try {
      const result = submitFeedback({ title: feedbackTitle(), body: feedbackBody() })
      setFeedbackStatus(`sent: ${result.url}`)
      setFeedbackTitle("")
      setFeedbackBody("")
      setBodyRow(0)
    } catch (err) {
      setFeedbackStatus(`error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // The Feedback section is an inline form (title → description → Send),
  // not a row list. While it holds focus we suspend this dialog's own
  // j/k/h/l/t nav (it'd swallow keystrokes from the inputs — the same
  // "l-is-eaten" class the standalone guard handles) and drive the form
  // with a dedicated Tab cycle + a Send-row Enter binding below.
  const editingFeedback = () => section() === "feedback" && level() === "body"

  // Tab walks title → description → Send → back to the sidebar (the
  // keyboard escape hatch, since left/h are owned by the inputs while
  // editing); Shift+Tab walks it backwards.
  function feedbackFieldStep(delta: 1 | -1): void {
    const next = bodyRow() + delta
    if (next < 0 || next > 2) {
      setLevel("sidebar")
      return
    }
    setBodyRow(next)
  }

  function enterBody(): void {
    if (level() !== "sidebar" || bodyRowCount() === 0) return
    setLevel("body")
    setBodyRow(0)
    if (section() === "general") setThemeCursor(0)
  }

  function moveCursor(delta: number): void {
    if (level() === "sidebar") {
      const next = (cursor() + delta + SECTIONS.length) % SECTIONS.length
      setCursor(next)
      const nextSection = SECTIONS[next]
      if (nextSection) {
        setSection(nextSection.id)
        setBodyRow(0)
      }
      return
    }
    const len = bodyRowCount()
    if (len === 0) return
    const next = (bodyRow() + delta + len) % len
    setBodyRow(next)
    if (rowAt(bodyRows(), next)?.kind === "theme") setThemeCursor(next)
  }

  function switchSection(id: SectionId): void {
    setSection(id)
    setCursor(SECTIONS.findIndex((s) => s.id === id))
    setBodyRow(0)
    setLevel("sidebar")
  }

  /**
   * Activation lookup, keyed by row kind. Payload-bearing rows (theme,
   * accent slot, engine vendor, surface) carry their payload in the
   * descriptor, so enter never reverse-engineers it from an index.
   */
  const rowActivators: { [K in SettingsRow["kind"]]: (row: Extract<SettingsRow, { kind: K }>) => void } = {
    theme: (row) => selectTheme(row.name),
    language: (row) => selectLanguage(row.locale),
    transparent: () => toggleTransparent(),
    focusAccent: (row) => selectFocusAccent(row.slot),
    toast: () => toggleToast(),
    sound: () => toggleSound(),
    zenKeepTasks: () => toggleZenKeepsTasks(),
    surface: (row) => selectSurface(row.surface),
    editorKind: () => cycleEditorKind(),
    editorCustom: () => void editEditorCustom(),
    worktreeBase: () => cycleWorktreeBase(),
    worktreeCustom: () => void editWorktreeCustom(),
    engine: (row) => void editEngine(row.vendor),
    engineAdd: () => void addEngineFlow(), // the trailing "+ Add engine" row
    feedbackTitle: () => setBodyRow(0),
    feedbackBody: () => setBodyRow(1),
    feedbackSend: () => void sendFeedback(),
    devReset: () => void confirmResetState(dialog, props.kv, renderer),
    devRestartDaemon: () => void confirmRestartDaemon(dialog, props.orchestrator, renderer),
    devRemoteProjects: () => toggleRemoteProjects(),
    devAutoStatus: () => toggleAutoStatus(),
    devDispatcher: () => toggleDispatcher(),
    devArchivedHistory: () => toggleArchivedHistory(),
  }

  function activateBodyRow(): void {
    const row = rowAt(bodyRows(), bodyRow())
    if (!row) return
    ;(rowActivators[row.kind] as (row: SettingsRow) => void)(row)
  }

  useBindings(() => ({
    // On the standalone page, suspend our navigation keys while a
    // sub-dialog (the engine-command / custom-editor text input) is open
    // so `l`/`t`/`j`/`k`/`h` reach the input instead of being eaten by
    // this dialog's nav. The overlay surface unmounts us when covered, so
    // there it's always enabled.
    enabled: (!props.standalone || dialog.stack.length === 0) && !editingFeedback(),
    bindings: [
      { key: "down", cmd: () => moveCursor(1) },
      { key: "up", cmd: () => moveCursor(-1) },
      { key: "j", cmd: () => moveCursor(1) },
      { key: "k", cmd: () => moveCursor(-1) },
      { key: "tab", cmd: () => moveCursor(1) },
      { key: "right", cmd: enterBody },
      { key: "l", cmd: enterBody },
      { key: "left", cmd: () => setLevel("sidebar") },
      { key: "h", cmd: () => setLevel("sidebar") },
      {
        key: "return",
        cmd: () => {
          if (level() === "sidebar") {
            enterBody()
            return
          }
          activateBodyRow()
        },
      },
      {
        key: "t",
        cmd: toggleTransparent,
      },
      {
        // Engines section only: `r` renames the focused engine's display
        // label, `x` resets a built-in (or removes a custom) engine. Gated to a
        // focused engine row (currentEngineRow null on the +Add row / elsewhere).
        key: "r",
        cmd: () => {
          const v = currentEngineRow()
          if (v) void renameEngine(v)
        },
      },
      {
        key: "x",
        cmd: () => {
          const v = currentEngineRow()
          if (v) resetEngine(v)
        },
      },
      {
        // Engines section: `d` sets the focused engine as the DEFAULT for new
        // tasks (the ● marker) — the same `lastSelectedVendor` Ctrl+Shift+T sets.
        key: "d",
        cmd: () => {
          const v = currentEngineRow()
          if (v) setEngineDefault(v)
        },
      },
    ],
  }))

  // Feedback-form navigation, live only while that form holds focus.
  // Tab / Shift+Tab cycle the fields; Enter on the title input is left to
  // its own onSubmit (advance to body, so it isn't swallowed here); Enter
  // in the body textarea inserts a newline (no binding intercepts it at
  // bodyRow 1); and Enter on the focused Send row commits — gated to
  // bodyRow 2 so it stays out of the dispatch stack while a field is focused.
  useBindings(() => ({
    enabled: editingFeedback(),
    bindings: [
      { key: "tab", cmd: () => feedbackFieldStep(1) },
      { key: "shift+tab", cmd: () => feedbackFieldStep(-1) },
    ],
  }))
  useBindings(() => ({
    enabled: editingFeedback() && bodyRow() === 2,
    bindings: [{ key: "return", cmd: () => void sendFeedback() }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("settings.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          {t("settings.esc")}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <SettingsSectionSidebar level={level} cursor={cursor} switchSection={switchSection} />
        <box flexGrow={1} flexShrink={1} flexDirection="column" gap={1}>
          <Show when={section() === "general"}>
            <GeneralSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              themeNames={themeNames}
              setThemeCursor={setThemeCursor}
              selectTheme={selectTheme}
              currentLocale={currentLocale}
              selectLanguage={selectLanguage}
              toggleTransparent={toggleTransparent}
              selectFocusAccent={selectFocusAccent}
              toastEnabled={toastEnabled}
              soundEnabled={soundEnabled}
              toggleToast={toggleToast}
              toggleSound={toggleSound}
              zenKeepsTasks={zenKeepsTasks}
              toggleZenKeepsTasks={toggleZenKeepsTasks}
              settingsSurface={settingsSurface}
              selectSurface={selectSurface}
              editorKind={editorKind}
              cycleEditorKind={cycleEditorKind}
              editorCustomCommand={editorCustomCommand}
              editEditorCustom={() => void editEditorCustom()}
              worktreeKind={worktreeKind}
              worktreeKindLabel={worktreeKindLabel}
              cycleWorktreeBase={cycleWorktreeBase}
              worktreeCustomPath={worktreeCustomPath}
              editWorktreeCustom={() => void editWorktreeCustom()}
            />
          </Show>
          <Show when={section() === "engines"}>
            <EngineSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              vendors={engineList()}
              isCustom={(v) => !isBuiltinVendor(v)}
              displayName={engineName}
              commandText={engineCommandText}
              isDefault={engineIsDefault}
              isDefaultEngine={isDefaultEngine}
              editEngine={(v) => void editEngine(v)}
              renameEngine={(v) => void renameEngine(v)}
              resetEngine={resetEngine}
              onAddEngine={() => void addEngineFlow()}
            />
          </Show>
          <Show when={section() === "accounts"}>
            <AccountsSettingsSection
              claudeStatus={claudeStatus}
              codexStatus={codexStatus}
              copilotStatus={copilotStatus}
            />
          </Show>
          <Show when={section() === "keys"}>
            <KeybindingsSettingsSection />
          </Show>
          <Show when={section() === "feedback"}>
            <FeedbackSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              title={feedbackTitle}
              setTitle={(v) => {
                setFeedbackTitle(v)
                setFeedbackStatus("")
              }}
              body={feedbackBody}
              setBody={(v) => {
                setFeedbackBody(v)
                setFeedbackStatus("")
              }}
              status={feedbackStatus}
              onTitleSubmit={() => setBodyRow(1)}
              submit={() => void sendFeedback()}
            />
          </Show>
          <Show when={section() === "dev"}>
            <DevSettingsSection
              level={level}
              bodyRow={bodyRow}
              setLevel={setLevel}
              setBodyRow={setBodyRow}
              hasDaemon={hasDaemon}
              confirmReset={() => void confirmResetState(dialog, props.kv, renderer)}
              confirmRestartDaemon={() => void confirmRestartDaemon(dialog, props.orchestrator, renderer)}
              remoteProjectsEnabled={remoteProjectsEnabled}
              toggleRemoteProjects={toggleRemoteProjects}
              autoStatusEnabled={autoStatusOn}
              toggleAutoStatus={toggleAutoStatus}
              dispatcherEnabled={dispatcherOn}
              toggleDispatcher={toggleDispatcher}
              archivedHistoryEnabled={archivedHistoryOn}
              toggleArchivedHistory={toggleArchivedHistory}
            />
          </Show>
        </box>
      </box>
      <box paddingTop={0}>
        <text fg={theme.textMuted}>{editingFeedback() ? t("settings.nav.feedback") : t("settings.nav.default")}</text>
      </box>
    </box>
  )
}

SettingsDialog.show = (
  dialog: DialogContext,
  kv: KVContext,
  orchestrator?: KobeOrchestrator,
): Promise<{ visualPrefsChanged: boolean }> => {
  let visualPrefsChanged = false
  return new Promise<{ visualPrefsChanged: boolean }>((resolve) => {
    dialog.replace(
      () => (
        <SettingsDialog
          kv={kv}
          orchestrator={orchestrator}
          onVisualPrefsChange={() => {
            visualPrefsChanged = true
          }}
          onClose={() => resolve({ visualPrefsChanged })}
        />
      ),
      () => resolve({ visualPrefsChanged }),
    )
  })
}
