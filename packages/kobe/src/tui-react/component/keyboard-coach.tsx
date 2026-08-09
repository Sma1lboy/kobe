/** @jsxImportSource @opentui/react */
/** One-time, non-modal coach that teaches the keyboard grammar by use. */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect } from "react"
import { formatChord } from "../../tui/lib/chord-glyphs"
import { legendCap } from "../../tui/lib/help-groups"
import { KEYBOARD_COACH_DONE, KEYBOARD_COACH_STEP_KEY, nextKeyboardCoachStep } from "../../tui/lib/keyboard-coach"
import { currentPrefixConfiguration } from "../../tui/lib/keymap-dispatch"
import { prefixHudState } from "../../tui/lib/prefix-hud"
import { SIDEBAR_WIDTH } from "../../tui/panes/sidebar/view-core"
import type { PaneId } from "../context/focus"
import { useKeymapVersion } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useAccessor } from "../lib/use-accessor"
import { useDialog } from "../ui/dialog"

export function KeyboardCoach(props: { focused: PaneId }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const t = useT()
  const kv = useKV()
  const dialog = useDialog()
  const hud = useAccessor(prefixHudState)
  useKeymapVersion()
  const focusSidebarKey = legendCap("focus.sidebar")
  const prefixKey = currentPrefixConfiguration().key
  const rawStep = kv.get(KEYBOARD_COACH_STEP_KEY, 0)
  const step = typeof rawStep === "number" ? rawStep : 0
  const last = hud.entries.at(-1)

  useEffect(() => {
    const next = nextKeyboardCoachStep(step, {
      focused: props.focused,
      lastAction: last?.action ?? null,
      lastWasPrefix: Boolean(last?.prefixKey),
      focusSidebarAvailable: focusSidebarKey !== null,
      prefixAvailable: prefixKey !== null,
    })
    if (next !== step) kv.set(KEYBOARD_COACH_STEP_KEY, next)
  }, [focusSidebarKey, kv, last, prefixKey, props.focused, step])

  const unavailableStep = (step === 1 && focusSidebarKey === null) || (step === 2 && prefixKey === null)
  if (step >= KEYBOARD_COACH_DONE || unavailableStep || hud.armed || dialog.stack.length > 0) return null
  return (
    <box
      position="absolute"
      zIndex={2300}
      left={SIDEBAR_WIDTH + 1}
      top={1}
      width={Math.max(28, dims.width - SIDEBAR_WIDTH - 3)}
      flexDirection="column"
      border
      borderColor={theme.borderActive}
      backgroundColor={theme.backgroundDialog}
      paddingLeft={1}
      paddingRight={1}
      onMouseUp={() => kv.set(KEYBOARD_COACH_STEP_KEY, KEYBOARD_COACH_DONE)}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {t("help.coach.title", { step: step + 1 })}
        </text>
        <text fg={theme.textMuted}>{t("help.coach.skip")}</text>
      </box>
      <text fg={theme.text} wrapMode="word">
        {step === 1
          ? t("help.coach.step1", { key: formatChord(focusSidebarKey ?? "") })
          : step === 2
            ? t("help.coach.step2", { key: formatChord(prefixKey ?? "") })
            : t("help.coach.step0")}
      </text>
    </box>
  )
}
