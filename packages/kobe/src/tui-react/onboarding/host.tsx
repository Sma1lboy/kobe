/** @jsxImportSource @opentui/react */
/**
 * First-run onboarding wizard — the inline (ink-style) UI half of
 * `src/cli/onboarding.ts`. Renders in a small main-screen footer (the
 * shell prompt history stays visible above), asks the two yes/no
 * questions, shows the "Keyboard basics" page (live-keymap grammar:
 * bare keys / one-press / prefix / help), then destroys the renderer and
 * resolves with the answers — applying them (fs writes, npx) happens back
 * in the CLI layer once the terminal is plain again. `q`/`esc` skips
 * setup: every unanswered step resolves as a decline, never a nag loop.
 */

import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useState } from "react"
import type { OnboardingChoices, ShellKind } from "../../cli/onboarding.ts"
import { wizardKeyLines } from "../../tui/lib/keyboard-hints"
import { currentPrefixConfiguration } from "../../tui/lib/keymap-dispatch"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { pageCloseBindings, useBindings } from "../lib/keymap"

/** header(2) + blank + answered(2) + keys title + 4 grammar lines + legend + slack */
const INLINE_ROWS = 15

type StepId = "completions" | "skill"

/** Exported for the render tests; production entry is {@link runOnboardingWizard}. */
export function WizardPage(props: { shell: ShellKind | null; onDone: (choices: OnboardingChoices) => void }) {
  const { theme } = useTheme()
  const t = useT()
  const renderer = useRenderer()
  // No shell detected → nothing to hook completions into; ask only about
  // the skill. The apply layer skips the completions summary line too.
  const steps: readonly StepId[] = props.shell === null ? ["skill"] : ["completions", "skill"]
  const [stepIndex, setStepIndex] = useState(0)
  const [yes, setYes] = useState(true)
  const [answers, setAnswers] = useState<Partial<Record<StepId, boolean>>>({})
  // After the questions, one informational "Keyboard basics" page — enter
  // (or the usual q/esc skip) finishes; there is nothing to answer on it.
  const [onKeysPage, setOnKeysPage] = useState(false)

  const step = steps[stepIndex] as StepId

  function finish(finalAnswers: Partial<Record<StepId, boolean>>): void {
    renderer?.destroy()
    props.onDone({ completions: finalAnswers.completions ?? false, skill: finalAnswers.skill ?? false })
  }

  // `choice` defaults to the keyboard cursor; mouse passes its own option
  // explicitly (setYes + read-back in one handler would see a stale render).
  function confirm(choice: boolean = yes): void {
    if (onKeysPage) {
      finish(answers)
      return
    }
    const next = { ...answers, [step]: choice }
    setAnswers(next)
    if (stepIndex + 1 >= steps.length) {
      setOnKeysPage(true)
      return
    }
    setStepIndex(stepIndex + 1)
    setYes(true)
  }

  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => setYes(true) },
      { key: "k", cmd: () => setYes(true) },
      { key: "down", cmd: () => setYes(false) },
      { key: "j", cmd: () => setYes(false) },
      { key: "return", cmd: () => confirm() },
      ...pageCloseBindings(() => finish(answers)),
    ],
  }))

  function questionFor(s: StepId): string {
    return s === "completions"
      ? t("onboarding.completionsQuestion", { shell: props.shell ?? "" })
      : t("onboarding.skillQuestion")
  }
  const explain = step === "completions" ? t("onboarding.completionsExplain") : t("onboarding.skillExplain")

  // Transcript flow, no backgrounds anywhere: answered questions stay on
  // screen as one muted line each (question + chosen answer), the active
  // question flows naturally below them — the npm-create feel, not a form.
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingLeft={2} paddingRight={2}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
        {t("onboarding.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("onboarding.subtitle")}
      </text>
      <box flexDirection="column" paddingTop={1}>
        {steps.slice(0, onKeysPage ? steps.length : stepIndex).map((answered) => (
          <box key={answered} flexDirection="row" gap={1}>
            <text fg={theme.success} wrapMode="none">
              ✓
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {questionFor(answered)}
            </text>
            <text fg={theme.text} wrapMode="none">
              {answers[answered] ? t("onboarding.optionYes") : t("onboarding.optionNo")}
            </text>
          </box>
        ))}
        {onKeysPage ? (
          <box flexDirection="column" onMouseUp={() => confirm()}>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
              {t("onboarding.keysTitle")}
            </text>
            {wizardKeyLines(currentPrefixConfiguration().key).map((line) => (
              <text key={line.msg} fg={theme.textMuted} wrapMode="word">
                {t(`onboarding.${line.msg}`, line.params)}
              </text>
            ))}
          </box>
        ) : (
          <>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
              {questionFor(step)}
            </text>
            <text fg={theme.textMuted} wrapMode="word">
              {explain}
            </text>
            {[true, false].map((option) => {
              const active = yes === option
              return (
                <box key={String(option)} flexDirection="row" gap={1} paddingLeft={1} onMouseUp={() => confirm(option)}>
                  <text fg={active ? theme.primary : theme.textMuted} wrapMode="none">
                    {active ? "❯" : " "}
                  </text>
                  <text
                    fg={active ? theme.primary : theme.textMuted}
                    attributes={active ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {option ? t("onboarding.optionYes") : t("onboarding.optionNo")}
                  </text>
                </box>
              )
            })}
          </>
        )}
      </box>
      <box paddingTop={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {t(onKeysPage ? "onboarding.keysLegend" : "onboarding.legend")}
        </text>
      </box>
    </box>
  )
}

/** Boot the inline wizard and resolve with the user's answers. */
export async function runOnboardingWizard(shell: ShellKind | null): Promise<OnboardingChoices> {
  return await new Promise<OnboardingChoices>((resolve) => {
    void bootPaneHost({
      inlineRows: INLINE_ROWS,
      setup: () => ({ root: () => <WizardPage shell={shell} onDone={resolve} /> }),
    })
  })
}
