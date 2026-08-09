/** @jsxImportSource @opentui/react */
/**
 * Bottom-left prefix HUD (over the Tasks sidebar — NOT the terminal column,
 * where it collided with the engine's own status line): while the PureTUI
 * prefix is armed it shows a live `ctrl+a ⋯` line, and each resolved
 * sequence lands a `ctrl+a + t → tab.new` line (or `∅` on a miss). The last
 * three lines stream like a mini log and flush PREFIX_HUD_TTL_MS after they
 * land — flush timers live HERE; the framework-free feed only timestamps
 * (src/tui/lib/prefix-hud.ts), so headless dispatch stays timer-free.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import { KobeKeymap, findBinding } from "../../tui/context/keybindings"
import { currentPrefixConfiguration } from "../../tui/lib/keymap-dispatch"
import { PREFIX_GUIDE_DELAY_MS, PREFIX_HUD_TTL_MS, prefixHudState } from "../../tui/lib/prefix-hud"
import { truncateEnd } from "../../tui/lib/truncate"
import { useTheme } from "../context/theme"
import { tKeys, useT } from "../i18n"
import { useAccessor } from "../lib/use-accessor"

const BOTTOM_MARGIN = 1

/**
 * Human label for a resolved action: the KobeKeymap row's help description,
 * clipped at its `:` lead when present (`Quick-fork: create child task…` →
 * `Quick-fork`). Falls back to the raw id for rows without a description.
 */
function actionLabel(action: string): string {
  const binding = findBinding(action)
  if (!binding) return action
  return tKeys("desc", action)
}

type GuideAction = { action: string; strokes: string[] }
type GuideGroup = { category: string; actions: GuideAction[] }

function guideCategory(action: string): string {
  if (["kanban.open", "automations.open", "workItems.open"].includes(action)) return "Views"
  if (action.startsWith("focus.")) return "Navigation"
  if (action.startsWith("inbox.") || action.startsWith("attention.")) return "Attention"
  if (action.startsWith("chat.tab.") || action.startsWith("chat.session.")) return "Sessions"
  if (action.startsWith("chat.fork.") || action.startsWith("task.")) return "Tasks"
  if (action.startsWith("settings.") || action === "workspace.zenToggle") return "Tools"
  return findBinding(action)?.category ?? "Global"
}

/** Keep catalogue order while collapsing aliases such as p / shift+p. */
export function groupPrefixGuideOptions(options: readonly { stroke: string; action: string }[]): GuideGroup[] {
  const order = new Map(KobeKeymap.map((binding, index) => [binding.id, index]))
  const byAction = new Map<string, GuideAction>()
  for (const option of options) {
    const current = byAction.get(option.action)
    if (current) current.strokes.push(option.stroke)
    else byAction.set(option.action, { action: option.action, strokes: [option.stroke] })
  }
  const groups = new Map<string, GuideAction[]>()
  const actions = [...byAction.values()].sort(
    (a, b) => (order.get(a.action) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.action) ?? Number.MAX_SAFE_INTEGER),
  )
  for (const action of actions) {
    const category = guideCategory(action.action)
    const rows = groups.get(category)
    if (rows) rows.push(action)
    else groups.set(category, [action])
  }
  return [...groups].map(([category, rows]) => ({ category, actions: rows }))
}

export function PrefixHud(props: { left: number; width: number }) {
  const { theme } = useTheme()
  const t = useT()
  const dims = useTerminalDimensions()
  const hud = useAccessor(prefixHudState)
  const [, setFlushTick] = useState(0)

  const now = Date.now()
  const fresh = hud.entries.filter((entry) => now - entry.at < PREFIX_HUD_TTL_MS)

  // Wake up when the oldest visible line crosses its TTL so it flushes out.
  const oldestAt = fresh[0]?.at
  useEffect(() => {
    if (oldestAt === undefined) return
    const timer = setTimeout(
      () => setFlushTick((tick) => tick + 1),
      Math.max(30, oldestAt + PREFIX_HUD_TTL_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [oldestAt])

  useEffect(() => {
    if (!hud.armed || hud.armedAt === null) return
    const remaining = hud.armedAt + PREFIX_GUIDE_DELAY_MS - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setFlushTick((tick) => tick + 1), remaining)
    return () => clearTimeout(timer)
  }, [hud.armed, hud.armedAt])

  const lineCount = fresh.length + (hud.armed ? 1 : 0)
  if (lineCount === 0) return null
  const armedKey = currentPrefixConfiguration().key ?? ""
  const showGuide = hud.armed && hud.armedAt !== null && now - hud.armedAt >= PREFIX_GUIDE_DELAY_MS
  const groups = showGuide ? groupPrefixGuideOptions(hud.options) : []

  if (showGuide) {
    const narrow = dims.width < 88
    const columns = narrow ? 1 : Math.min(3, Math.max(1, groups.length))
    const groupRows = Array.from({ length: Math.ceil(groups.length / columns) }, (_, index) =>
      groups.slice(index * columns, (index + 1) * columns),
    )
    const guideHeight = groupRows.reduce(
      (height, row) => height + Math.max(1, ...row.map((group) => group.actions.length)) + 1,
      3,
    )
    const guideWidth = Math.max(20, dims.width - 4)
    const top = Math.max(0, dims.height - BOTTOM_MARGIN - guideHeight)
    const groupWidth = narrow ? guideWidth - 4 : Math.max(18, Math.floor((guideWidth - 4) / columns))
    return (
      <box
        position="absolute"
        zIndex={2400}
        left={2}
        top={top}
        width={guideWidth}
        border
        borderColor={theme.borderActive}
        backgroundColor={theme.backgroundDialog}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.primary}>{t("help.commandLayer", { prefix: armedKey })}</text>
          <text fg={theme.textMuted}>{t("help.escCancel")}</text>
        </box>
        <box flexDirection="column">
          {groupRows.map((row) => (
            <box key={row.map((group) => group.category).join("-")} flexDirection="row" gap={narrow ? 0 : 1}>
              {row.map((group) => (
                <box key={group.category} flexDirection="column" flexGrow={1} flexBasis={0}>
                  <text fg={theme.accent}>{tKeys("category", group.category)}</text>
                  {group.actions.map((action) => {
                    const strokes = action.strokes.join("/")
                    const label = truncateEnd(actionLabel(action.action), Math.max(4, groupWidth - strokes.length - 3))
                    return (
                      <box key={action.action} flexDirection="row" gap={1}>
                        <box width={Math.min(9, Math.max(3, strokes.length))}>
                          <text fg={theme.primary}>{strokes}</text>
                        </box>
                        <text fg={theme.text} wrapMode="none">
                          {label}
                        </text>
                      </box>
                    )
                  })}
                </box>
              ))}
            </box>
          ))}
        </box>
      </box>
    )
  }

  const top = Math.max(0, dims.height - BOTTOM_MARGIN - lineCount)

  return (
    <box position="absolute" zIndex={2400} left={props.left} top={top} width={props.width} flexDirection="column">
      {fresh.map((entry) => (
        <box key={entry.id} paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundDialog}>
          <text fg={theme.textMuted} wrapMode="none">
            {truncateEnd(
              `${entry.prefixKey ? `${entry.prefixKey} + ` : ""}${entry.stroke} ${
                entry.action ? `→ ${actionLabel(entry.action)}` : "∅"
              }`,
              props.width - 2,
            )}
          </text>
        </box>
      ))}
      {hud.armed ? (
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundDialog}>
          <text fg={theme.textMuted} wrapMode="none">
            {`${armedKey} ⋯`}
          </text>
        </box>
      ) : null}
    </box>
  )
}
