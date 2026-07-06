/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import type { ClaudeAccount, CodexAccount, CopilotAccount, EngineAccountStatus } from "../../../engine/account-detect"
import type { VendorId } from "../../../types/task"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import type { SectionCursorProps } from "./rows"

export function EngineSettingsSection(
  props: SectionCursorProps & {
    vendors: readonly VendorId[]
    displayName: (vendor: VendorId) => string
    commandText: (vendor: VendorId) => string
    isDefault: (vendor: VendorId) => boolean
    isCustom: (vendor: VendorId) => boolean
    isDefaultEngine: (vendor: VendorId) => boolean
    editEngine: (vendor: VendorId) => void
    onAddEngine: () => void
  },
) {
  const { theme } = useTheme()
  const t = useT()
  const addRowIndex = props.vendors.length
  const isBodyCursor = (row: number) => props.level === "body" && props.bodyRow === row
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.engines.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.engines.hint")}
      </text>
      <box flexDirection="column" gap={0}>
        {props.vendors.map((vendor, i) => {
          const isCursor = isBodyCursor(i)
          return (
            <box
              key={vendor}
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isCursor ? theme.primary : undefined}
              onMouseUp={() => {
                props.setLevel("body")
                props.setBodyRow(i)
                props.editEngine(vendor)
              }}
            >
              {}
              <text
                fg={isCursor ? theme.selectedListItemText : theme.accent}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
              >
                {props.isDefaultEngine(vendor) ? "●" : " "}
              </text>
              <text
                fg={isCursor ? theme.selectedListItemText : theme.text}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
              >
                {props.displayName(vendor)}
              </text>
              <text
                fg={isCursor ? theme.selectedListItemText : props.isDefault(vendor) ? theme.textMuted : theme.accent}
                wrapMode="none"
              >
                {props.commandText(vendor) +
                  (props.isDefault(vendor)
                    ? t("settings.engines.defaultTag")
                    : props.isCustom(vendor)
                      ? t("settings.engines.customTag")
                      : "")}
              </text>
            </box>
          )
        })}
        {}
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isBodyCursor(addRowIndex) ? theme.primary : undefined}
          onMouseUp={() => {
            props.setLevel("body")
            props.setBodyRow(addRowIndex)
            props.onAddEngine()
          }}
        >
          <text fg={isBodyCursor(addRowIndex) ? theme.selectedListItemText : theme.primary} wrapMode="none">
            {t("settings.engines.addEngine")}
          </text>
        </box>
      </box>
    </box>
  )
}

function AccountBlock(props: {
  name: string
  status: EngineAccountStatus<unknown> | null
  accountLine: (status: EngineAccountStatus<unknown>) => ReactNode
}) {
  const { theme } = useTheme()
  const t = useT()
  const s = props.status
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.name}
      </text>
      {s === null ? (
        <text fg={theme.textMuted}>{t("settings.accounts.checking")}</text>
      ) : (
        <box flexDirection="column" gap={0}>
          <text fg={s.binary.found ? theme.textMuted : theme.warning} wrapMode="word">
            {s.binary.found
              ? `Binary: ${(s.binary as { path: string }).path}`
              : `Binary: ${(s.binary as { error: string }).error}`}
          </text>
          {props.accountLine(s)}
          {s.accountError ? (
            <text fg={theme.warning} wrapMode="word">
              {`! ${s.accountError}`}
            </text>
          ) : null}
        </box>
      )}
    </box>
  )
}

export function AccountsSettingsSection(props: {
  claudeStatus: EngineAccountStatus<ClaudeAccount> | null
  codexStatus: EngineAccountStatus<CodexAccount> | null
  copilotStatus: EngineAccountStatus<CopilotAccount> | null
}) {
  const { theme } = useTheme()
  const t = useT()
  const notLoggedIn = <text fg={theme.textMuted}>{t("settings.accounts.notLoggedIn")}</text>
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.accounts.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.accounts.hint")}
      </text>
      <AccountBlock
        name="claude-code"
        status={props.claudeStatus}
        accountLine={(s) => {
          const a = s.account as ClaudeAccount
          if (a.kind === "oauth") {
            const tail = [a.organization, a.billingType].filter((x): x is string => !!x).join(" · ")
            return (
              <text fg={theme.success} wrapMode="word">
                {t("settings.accounts.loggedIn", { email: a.email }) + (tail ? ` (${tail})` : "")}
              </text>
            )
          }
          return notLoggedIn
        }}
      />
      <AccountBlock
        name="codex"
        status={props.codexStatus}
        accountLine={(s) => {
          const a = s.account as CodexAccount
          if (a.kind === "chatgpt") {
            return (
              <text fg={theme.success} wrapMode="word">
                {t("settings.accounts.chatgptLogin", { email: a.email }) + (a.plan ? ` (${a.plan})` : "")}
              </text>
            )
          }
          if (a.kind === "apikey") return <text fg={theme.success}>{t("settings.accounts.apiKeyConfigured")}</text>
          return notLoggedIn
        }}
      />
      <AccountBlock
        name="copilot"
        status={props.copilotStatus}
        accountLine={(s) => {
          const a = s.account as CopilotAccount
          if (a.kind === "token")
            return <text fg={theme.success}>{t("settings.accounts.tokenConfigured", { source: a.source })}</text>
          if (a.kind === "oauth") return <text fg={theme.success}>{t("settings.accounts.copilotDetected")}</text>
          return notLoggedIn
        }}
      />
    </box>
  )
}
