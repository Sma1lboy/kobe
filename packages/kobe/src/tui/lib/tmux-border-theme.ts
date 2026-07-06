import { readFileSync } from "node:fs"
import { kvStatePath } from "../../env"
import { runTmuxCapturing, runTmuxSequence } from "../../tmux/client"
import type { ThemeJson } from "../context/theme"
import { BUNDLED_THEME_JSONS } from "../context/theme/bundled"
import { resolveThemeSlotHex } from "../context/theme/hex"
import { loadUserThemes } from "../context/theme/loader"

export const TMUX_CHROME_THEME_MARKER_OPTION = "@kobe_border_theme"

export const BORDER_THEME_MARKER_OPTION = TMUX_CHROME_THEME_MARKER_OPTION

const FOCUS_ACCENT_SLOT_NAMES = ["primary", "success", "info"] as const

interface TmuxChromePrefs {
  readonly themeName: string
  readonly focusAccentSlot: string
  readonly enabled: boolean
}

function readTmuxChromePrefs(): TmuxChromePrefs {
  try {
    const parsed = JSON.parse(readFileSync(kvStatePath(), "utf8")) as Record<string, unknown>
    const themeName = typeof parsed.activeTheme === "string" && parsed.activeTheme ? parsed.activeTheme : "claude"
    const focusAccentSlot =
      typeof parsed.focusAccent === "string" &&
      (FOCUS_ACCENT_SLOT_NAMES as readonly string[]).includes(parsed.focusAccent)
        ? parsed.focusAccent
        : "primary"
    return {
      themeName,
      focusAccentSlot,
      enabled: parsed.tmuxChromeTheme !== "off" && parsed.tmuxBorderTheme !== "off",
    }
  } catch {
    return { themeName: "claude", focusAccentSlot: "primary", enabled: true }
  }
}

function lookupThemeJson(name: string): ThemeJson | null {
  const user = loadUserThemes().find((t) => t.name === name)
  return user?.theme ?? BUNDLED_THEME_JSONS[name] ?? null
}

export function resolveBorderHexes(
  theme: ThemeJson,
  focusAccentSlot: string,
): { border: string | null; active: string | null } {
  const hexes = resolveTmuxChromeHexes(theme, focusAccentSlot)
  const border = hexes.border
  const active = hexes.activeBorder
  return { border, active }
}

export interface TmuxChromeHexes {
  readonly border: string | null
  readonly activeBorder: string | null
  readonly statusBg: string | null
  readonly statusFg: string | null
  readonly statusMutedFg: string | null
  readonly windowFg: string | null
  readonly currentWindowBg: string | null
  readonly currentWindowFg: string | null
  readonly activityFg: string | null
  readonly bellFg: string | null
  readonly messageBg: string | null
  readonly messageFg: string | null
  readonly messageCommandFg: string | null
  readonly modeBg: string | null
  readonly modeFg: string | null
}

function firstHex(theme: ThemeJson, ...slots: string[]): string | null {
  for (const slot of slots) {
    const hex = resolveThemeSlotHex(theme, slot)
    if (hex) return hex
  }
  return null
}

export function resolveTmuxChromeHexes(theme: ThemeJson, focusAccentSlot: string): TmuxChromeHexes {
  const text = firstHex(theme, "text")
  const background = firstHex(theme, "background")
  const textMuted = firstHex(theme, "textMuted", "text")
  const backgroundPanel = firstHex(theme, "backgroundPanel", "background")
  const backgroundElement = firstHex(theme, "backgroundElement", "backgroundPanel", "background")
  const backgroundMenu = firstHex(theme, "backgroundMenu", "backgroundElement", "backgroundPanel", "background")
  const selectedListItemText = firstHex(theme, "selectedListItemText", "background")
  const primary = firstHex(theme, focusAccentSlot, "primary", "borderActive", "border", "text")

  return {
    border: firstHex(theme, "border", "text"),
    activeBorder: primary,
    statusBg: backgroundPanel,
    statusFg: textMuted,
    statusMutedFg: textMuted,
    windowFg: textMuted,
    currentWindowBg: backgroundElement,
    currentWindowFg: primary,
    activityFg: firstHex(theme, "info", "primary", "text"),
    bellFg: firstHex(theme, "warning", "error", "primary", "text"),
    messageBg: backgroundMenu,
    messageFg: text,
    messageCommandFg: primary,
    modeBg: primary,
    modeFg: selectedListItemText ?? background,
  }
}

export interface BorderThemePlanInput {
  readonly marker: string
  readonly currentBorder: string
  readonly currentActive: string
  readonly borderHex: string | null
  readonly activeHex: string | null
}

export function planBorderTheme(input: BorderThemePlanInput): string[][] {
  const owned = new Set(
    input.marker
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const commands: string[][] = []
  const nextOwned: string[] = []

  const options = [
    { key: "border", option: "pane-border-style", current: input.currentBorder, hex: input.borderHex },
    { key: "active", option: "pane-active-border-style", current: input.currentActive, hex: input.activeHex },
  ] as const

  for (const o of options) {
    if (o.hex) {
      const style = `fg=${o.hex}`
      if (o.current !== style) commands.push(["set-option", "-gw", o.option, style])
      nextOwned.push(o.key)
    } else if (owned.has(o.key)) {
      commands.push(["set-option", "-gwu", o.option])
    }
  }

  const nextMarker = nextOwned.join(",")
  if (nextMarker !== input.marker) {
    commands.push(
      nextMarker
        ? ["set-option", "-g", BORDER_THEME_MARKER_OPTION, nextMarker]
        : ["set-option", "-gu", BORDER_THEME_MARKER_OPTION],
    )
  }
  return commands
}

export type TmuxChromeOptionKey =
  | "border"
  | "active"
  | "status"
  | "status-left"
  | "status-right"
  | "window"
  | "current-window"
  | "activity-window"
  | "bell-window"
  | "last-window"
  | "message"
  | "message-command"
  | "mode"
  | "display-panes"
  | "display-panes-active"

interface TmuxChromeOptionValue {
  readonly key: TmuxChromeOptionKey
  readonly option: string
  readonly showFlag: "-gqv" | "-gwqv"
  readonly setFlag: "-g" | "-gw"
  readonly unsetFlag: "-gu" | "-gwu"
  readonly value: string | null
}

function style(parts: { bg?: string | null; fg?: string | null; attrs?: readonly string[] }): string | null {
  const chunks: string[] = []
  if (parts.bg) chunks.push(`bg=${parts.bg}`)
  if (parts.fg) chunks.push(`fg=${parts.fg}`)
  if (chunks.length === 0) return null
  if (parts.attrs) chunks.push(...parts.attrs)
  return chunks.join(",")
}

function tmuxChromeOptionValues(hexes: TmuxChromeHexes): TmuxChromeOptionValue[] {
  const statusStyle = style({ bg: hexes.statusBg, fg: hexes.statusFg })
  const statusMutedStyle = style({ bg: hexes.statusBg, fg: hexes.statusMutedFg })
  const windowStyle = style({ bg: hexes.statusBg, fg: hexes.windowFg })
  return [
    {
      key: "border",
      option: "pane-border-style",
      showFlag: "-gwqv",
      setFlag: "-gw",
      unsetFlag: "-gwu",
      value: style({ fg: hexes.border }),
    },
    {
      key: "active",
      option: "pane-active-border-style",
      showFlag: "-gwqv",
      setFlag: "-gw",
      unsetFlag: "-gwu",
      value: style({ fg: hexes.activeBorder }),
    },
    {
      key: "status",
      option: "status-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: statusStyle,
    },
    {
      key: "status-left",
      option: "status-left-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: statusMutedStyle,
    },
    {
      key: "status-right",
      option: "status-right-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: statusMutedStyle,
    },
    {
      key: "window",
      option: "window-status-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: windowStyle,
    },
    {
      key: "current-window",
      option: "window-status-current-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.currentWindowBg, fg: hexes.currentWindowFg, attrs: ["bold"] }),
    },
    {
      key: "activity-window",
      option: "window-status-activity-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.statusBg, fg: hexes.activityFg }),
    },
    {
      key: "bell-window",
      option: "window-status-bell-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.statusBg, fg: hexes.bellFg, attrs: ["bold"] }),
    },
    {
      key: "last-window",
      option: "window-status-last-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.statusBg, fg: hexes.statusFg }),
    },
    {
      key: "message",
      option: "message-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.messageBg, fg: hexes.messageFg }),
    },
    {
      key: "message-command",
      option: "message-command-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.messageBg, fg: hexes.messageCommandFg, attrs: ["bold"] }),
    },
    {
      key: "mode",
      option: "mode-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.modeBg, fg: hexes.modeFg }),
    },
    {
      key: "display-panes",
      option: "display-panes-colour",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: hexes.border,
    },
    {
      key: "display-panes-active",
      option: "display-panes-active-colour",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: hexes.activeBorder,
    },
  ]
}

export interface TmuxChromeThemePlanInput {
  readonly marker: string
  readonly current: Partial<Record<TmuxChromeOptionKey, string>>
  readonly hexes: TmuxChromeHexes
}

export function planTmuxChromeTheme(input: TmuxChromeThemePlanInput): string[][] {
  const owned = new Set(
    input.marker
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const commands: string[][] = []
  const nextOwned: string[] = []

  for (const item of tmuxChromeOptionValues(input.hexes)) {
    if (item.value) {
      if ((input.current[item.key] ?? "") !== item.value) {
        commands.push(["set-option", item.setFlag, item.option, item.value])
      }
      nextOwned.push(item.key)
    } else if (owned.has(item.key)) {
      commands.push(["set-option", item.unsetFlag, item.option])
    }
  }

  const nextMarker = nextOwned.join(",")
  if (nextMarker !== input.marker) {
    commands.push(
      nextMarker
        ? ["set-option", "-g", TMUX_CHROME_THEME_MARKER_OPTION, nextMarker]
        : ["set-option", "-gu", TMUX_CHROME_THEME_MARKER_OPTION],
    )
  }
  return commands
}

async function readOption(args: string[]): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(args)
  return code === 0 ? stdout.trim() : ""
}

export async function applyTmuxPaneBorderTheme(): Promise<void> {
  await applyTmuxChromeTheme()
}

export async function applyTmuxChromeTheme(): Promise<void> {
  try {
    const prefs = readTmuxChromePrefs()
    const themeJson = prefs.enabled ? lookupThemeJson(prefs.themeName) : null
    const hexes = themeJson
      ? resolveTmuxChromeHexes(themeJson, prefs.focusAccentSlot)
      : resolveTmuxChromeHexes({ theme: {} }, prefs.focusAccentSlot)
    const options = tmuxChromeOptionValues(hexes)
    const [marker, ...values] = await Promise.all([
      readOption(["show-options", "-gqv", TMUX_CHROME_THEME_MARKER_OPTION]),
      ...options.map((item) => readOption(["show-options", item.showFlag, item.option])),
    ])
    const current = Object.fromEntries(options.map((item, i) => [item.key, values[i] ?? ""]))
    const commands = planTmuxChromeTheme({ marker, current, hexes })
    if (commands.length > 0) await runTmuxSequence(commands)
  } catch {}
}
