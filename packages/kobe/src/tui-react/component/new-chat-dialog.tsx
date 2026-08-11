/** @jsxImportSource @opentui/react */
/**
 * Unified new-conversation dialog (issue #7) — ONE entry for every "start a
 * new chat" shape. The default state is the old `chat.tab.chooseEngine`
 * (ctrl+e) picker verbatim: engine list (+ shell + plugin panes), ←/→
 * cycles, enter opens a fresh tab in this worktree. Two in-dialog toggles
 * bend the outcome, with the footer always showing their live state:
 *
 *   - `tab`    — destination: new tab here ⇄ fork a child task worktree
 *   - `ctrl+f` — context: fresh conversation ⇄ continue the current one
 *
 * Shell and plugin panes only make sense for the default combo (a pane
 * can't continue a conversation and doesn't live in a forked task), so
 * flipping either toggle narrows the choices to engines and clamps the
 * highlight onto one.
 *
 * `ctrl+a c` / `ctrl+a f` open this same dialog with a toggle pre-flipped
 * (see `use-tab-dialogs.ts`); the dispatch on submit lives there too.
 */

import { ALL_VENDORS, type VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog, useDialogPaddingX } from "../ui/dialog"
import { ChoiceRow } from "./new-task-dialog/picker-list"

/** What the picker can resolve to: an engine vendor or a plain shell tab.
 *  With `extraChoices`, an extra choice's `key` (e.g. a plugin pane) too. */
export type EnginePick = VendorId | "shell" | (string & {})

/** Where the new conversation lands. */
export type NewChatDestination = "tab" | "fork"
/** What it starts from. */
export type NewChatContext = "fresh" | "continue"

export interface NewChatChoice {
  readonly pick: EnginePick
  readonly destination: NewChatDestination
  readonly context: NewChatContext
}

export function NewChatDialogView(props: {
  availableVendors: readonly VendorId[]
  defaultVendor: VendorId
  /** Offer a trailing "shell" choice (a plain terminal tab). */
  allowShell?: boolean
  /** Trailing extra choices (plugin panes): `key` is returned, `label` shown. */
  extraChoices?: readonly { key: string; label: string }[]
  /** Preset entries (`ctrl+a c` / `ctrl+a f`) open with a toggle flipped. */
  initialDestination?: NewChatDestination
  initialContext?: NewChatContext
  onSubmit: (choice: NewChatChoice) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const padX = useDialogPaddingX()
  const vendors = props.availableVendors.length > 0 ? props.availableVendors : ALL_VENDORS
  const extras = props.extraChoices ?? []
  const [destination, setDestination] = useState<NewChatDestination>(props.initialDestination ?? "tab")
  const [context, setContext] = useState<NewChatContext>(props.initialContext ?? "fresh")

  // Shell/pane rows exist only in the default combo — anything else is an
  // engine conversation by definition.
  const defaultCombo = destination === "tab" && context === "fresh"
  const choices: readonly EnginePick[] = defaultCombo
    ? [...vendors, ...(props.allowShell ? (["shell"] as const) : []), ...extras.map((e) => e.key)]
    : vendors
  const fallback = vendors.includes(props.defaultVendor) ? props.defaultVendor : (vendors[0] ?? "claude")
  const [pick, setPick] = useState<EnginePick>(fallback)
  const display = (choice: EnginePick): string => extras.find((e) => e.key === choice)?.label ?? choice

  function commit(picked: EnginePick): void {
    props.onSubmit({ pick: picked, destination, context })
    dialog.clear()
  }

  const cycle = (dir: 1 | -1) =>
    setPick((cur) => {
      const i = choices.indexOf(cur)
      return choices[(i + dir + choices.length) % choices.length] ?? cur
    })

  /** Flip a toggle, clamping a shell/pane highlight back onto an engine. */
  const clampPick = () => setPick((cur) => (vendors.includes(cur as VendorId) ? cur : fallback))

  useBindings(() => ({
    bindings: [
      { key: "left", cmd: () => cycle(-1) },
      { key: "right", cmd: () => cycle(1) },
      { key: "h", cmd: () => cycle(-1) },
      { key: "l", cmd: () => cycle(1) },
      {
        key: "tab",
        cmd: () => {
          setDestination((d) => (d === "tab" ? "fork" : "tab"))
          clampPick()
        },
      },
      {
        key: "ctrl+f",
        cmd: () => {
          setContext((c) => (c === "fresh" ? "continue" : "fresh"))
          clampPick()
        },
      },
      { key: "return", cmd: () => commit(pick) },
    ],
  }))

  const destValue = destination === "tab" ? t("terminal.tab.newChat.destTab") : t("terminal.tab.newChat.destFork")
  const ctxValue = context === "fresh" ? t("terminal.tab.newChat.ctxFresh") : t("terminal.tab.newChat.ctxContinue")

  return (
    <box paddingLeft={padX} paddingRight={padX} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("terminal.tab.newChat.title")}
        </text>
        <text
          fg={theme.textMuted}
          onMouseUp={() => {
            // Cancel must also CLOSE — resolving the promise alone left the
            // card on screen with its onClose already spent.
            props.onCancel()
            dialog.clear()
          }}
        >
          esc
        </text>
      </box>
      <ChoiceRow choices={choices} selected={pick} display={display} onPick={(v) => commit(v)} />
      <box gap={0}>
        <box flexDirection="row">
          <text fg={theme.textMuted}>{t("terminal.tab.newChat.destLabel")}</text>
          <text fg={theme.text}>{destValue}</text>
        </box>
        <box flexDirection="row">
          <text fg={theme.textMuted}>{t("terminal.tab.newChat.ctxLabel")}</text>
          <text fg={theme.text}>{ctxValue}</text>
        </box>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("terminal.tab.chooseEngineHint")}</text>
      </box>
    </box>
  )
}

function show(
  dialog: DialogContext,
  availableVendors: readonly VendorId[],
  defaultVendor: VendorId,
  opts: {
    allowShell?: boolean
    extraChoices?: readonly { key: string; label: string }[]
    initialDestination?: NewChatDestination
    initialContext?: NewChatContext
  } = {},
): Promise<NewChatChoice | undefined> {
  return showDialog<NewChatChoice>(dialog, (resolve) => (
    <NewChatDialogView
      availableVendors={availableVendors}
      defaultVendor={defaultVendor}
      allowShell={opts.allowShell}
      extraChoices={opts.extraChoices}
      initialDestination={opts.initialDestination}
      initialContext={opts.initialContext}
      onSubmit={(choice) => resolve(choice)}
      onCancel={() => resolve(undefined)}
    />
  ))
}

export const NewChatDialog = {
  show,
}
