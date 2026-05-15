import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { Markdown } from "./Markdown"
import { BLACK_CIRCLE, RESULT_PREFIX } from "./message-figures"
import type { ChatRow } from "./row-types"

/**
 * Approval row — kobe's host-side rendering of an `ExitPlanMode` plan
 * approval request.
 */
export function ApprovalRow(props: {
  row: Extract<ChatRow, { kind: "approval" }>
  onApprove: (approve: boolean) => void
}) {
  const { theme } = useTheme()
  const r = () => props.row
  const isPending = () => r().status === "pending"

  const headerText = () => {
    if (r().status === "approved") return "User approved Claude's plan"
    if (r().status === "rejected") return "User rejected Claude's plan"
    return "Awaiting your approval"
  }
  const headerColor = () => {
    if (r().status === "approved") return theme.success
    if (r().status === "rejected") return theme.error
    return theme.warning
  }
  const headerGlyph = () => {
    if (r().status === "approved") return BLACK_CIRCLE
    if (r().status === "rejected") return BLACK_CIRCLE
    return "◆"
  }

  return (
    <box paddingTop={1} flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={headerColor()} attributes={TextAttributes.BOLD}>
          {headerGlyph()}
        </text>
        <text fg={headerColor()} attributes={TextAttributes.BOLD}>
          {headerText()}
        </text>
      </box>

      <Show when={r().filePath}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>
            {RESULT_PREFIX}Plan file: {r().filePath}
          </text>
        </box>
      </Show>

      <box paddingLeft={2} paddingTop={1}>
        <Markdown source={r().plan || "(empty plan)"} />
      </box>

      <box paddingLeft={2} paddingTop={1} flexDirection="row" gap={2}>
        <Show
          when={isPending()}
          fallback={
            <text fg={r().status === "approved" ? theme.success : theme.error} attributes={TextAttributes.BOLD}>
              [{r().status}]
            </text>
          }
        >
          <text fg={theme.success} attributes={TextAttributes.BOLD} onMouseUp={() => props.onApprove(true)}>
            [ Approve ]
          </text>
          <text fg={theme.error} attributes={TextAttributes.BOLD} onMouseUp={() => props.onApprove(false)}>
            [ Reject ]
          </text>
        </Show>
      </box>
    </box>
  )
}

/**
 * Sentinel label for the auto-added "Other / type your own answer" option.
 * It cannot collide with a real option label, even if the model supplies
 * an option named "Other".
 */
const OTHER_SENTINEL = "__kobe_other__"

/**
 * Question row — kobe's host-side rendering of an `AskUserQuestion` request.
 * Selection state stays local until Submit, then the final answer map is
 * routed up through `onAnswer`.
 */
export function QuestionRow(props: {
  row: Extract<ChatRow, { kind: "question" }>
  onAnswer: (answers: Record<string, string>) => void
  onClaimComposerFocus?: (claim: boolean) => void
  chatFocused?: Accessor<boolean>
}) {
  const { theme } = useTheme()
  const r = () => props.row
  const isAnswered = () => r().answers !== null
  const [selections, setSelections] = createSignal<Record<string, ReadonlySet<string>>>({})
  const [otherText, setOtherText] = createSignal<Record<string, string>>({})
  const [currentIndex, setCurrentIndex] = createSignal(0)

  function pickedFor(questionText: string): ReadonlySet<string> {
    return selections()[questionText] ?? new Set<string>()
  }

  function customTextFor(questionText: string): string {
    return otherText()[questionText] ?? ""
  }

  function setCustomText(questionText: string, value: string): void {
    const sanitized = value.replace(/[\r\n]+/g, "")
    setOtherText((prev) => ({ ...prev, [questionText]: sanitized }))
  }

  function currentOtherActive(): boolean {
    if (isAnswered()) return false
    const q = r().questions[currentIndex()]
    if (!q) return false
    return pickedFor(q.question).has(OTHER_SENTINEL)
  }
  createEffect(() => {
    props.onClaimComposerFocus?.(currentOtherActive())
  })
  onCleanup(() => {
    props.onClaimComposerFocus?.(false)
  })

  function toggle(questionText: string, multi: boolean, label: string): void {
    setSelections((prev) => {
      const cur = new Set(prev[questionText] ?? [])
      if (multi) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else if (cur.has(label) && cur.size === 1) {
        cur.clear()
      } else {
        cur.clear()
        cur.add(label)
      }
      return { ...prev, [questionText]: cur }
    })
  }

  function renderedAnswerFor(q: { question: string; options: readonly { label: string }[] }): string {
    const picked = pickedFor(q.question)
    const ordered: string[] = []
    for (const o of q.options) {
      if (picked.has(o.label)) ordered.push(o.label)
    }
    if (picked.has(OTHER_SENTINEL)) {
      const txt = customTextFor(q.question).trim()
      if (txt) ordered.push(txt)
    }
    return ordered.join(", ")
  }

  function isQuestionComplete(qIdx: number): boolean {
    const q = r().questions[qIdx]
    if (!q) return false
    const picked = pickedFor(q.question)
    if (picked.size === 0) return false
    if (picked.has(OTHER_SENTINEL) && customTextFor(q.question).trim().length === 0) return false
    return true
  }

  const allAnswered = () => {
    for (let i = 0; i < r().questions.length; i++) {
      if (!isQuestionComplete(i)) return false
    }
    return true
  }

  function submit(): void {
    if (!allAnswered() || isAnswered()) return
    const answers: Record<string, string> = {}
    for (const q of r().questions) {
      answers[q.question] = renderedAnswerFor(q)
    }
    props.onAnswer(answers)
  }

  function advanceOrSubmit(): void {
    if (isAnswered()) return
    const i = currentIndex()
    if (!isQuestionComplete(i)) return
    if (i >= r().questions.length - 1) submit()
    else setCurrentIndex(i + 1)
  }

  const [highlighted, setHighlighted] = createSignal(0)
  createEffect(() => {
    currentIndex()
    setHighlighted(0)
  })

  function toggleByIndex(qIdx: number, optIdx: number): void {
    const q = r().questions[qIdx]
    if (!q) return
    if (optIdx === q.options.length) {
      toggle(q.question, q.multiSelect, OTHER_SENTINEL)
    } else {
      const opt = q.options[optIdx]
      if (opt) toggle(q.question, q.multiSelect, opt.label)
    }
  }

  useBindings(() => ({
    enabled: !isAnswered() && !currentOtherActive() && (props.chatFocused?.() ?? true),
    bindings: bindByIds({
      "chat.question.nav": (evt) => {
        const q = r().questions[currentIndex()]
        if (!q) return
        const max = q.options.length
        if (evt.name === "j" || evt.name === "down") {
          setHighlighted((i) => Math.min(i + 1, max))
        } else if (evt.name === "k" || evt.name === "up") {
          setHighlighted((i) => Math.max(i - 1, 0))
        }
      },
      "chat.question.toggle": () => toggleByIndex(currentIndex(), highlighted()),
      "chat.question.submit": () => advanceOrSubmit(),
      "chat.question.pick-number": (evt) => {
        const n = Number.parseInt(evt.name ?? "", 10)
        if (!Number.isFinite(n) || n < 1) return
        const q = r().questions[currentIndex()]
        if (!q) return
        const idx = n - 1
        if (idx > q.options.length) return
        setHighlighted(idx)
        toggleByIndex(currentIndex(), idx)
      },
    }),
  }))

  return (
    <box paddingTop={1} flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          ◆
        </text>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          {isAnswered() ? "Answered" : "Awaiting your answer"}
        </text>
      </box>

      <For each={r().questions}>
        {(q, index) => {
          const finalAnswer = () => r().answers?.[q.question] ?? null
          const picked = () => pickedFor(q.question)
          const isCurrent = () => !isAnswered() && index() === currentIndex()
          const isPast = () => !isAnswered() && index() < currentIndex()
          const isFuture = () => !isAnswered() && index() > currentIndex()
          const isLast = () => index() === r().questions.length - 1
          const buttonLabel = () => (isLast() ? "[ Submit ]" : "[ Next ]")
          return (
            <Show when={!isFuture()}>
              <box
                paddingLeft={2}
                paddingTop={1}
                flexDirection="column"
                gap={0}
                onMouseUp={isPast() ? () => setCurrentIndex(index()) : undefined}
              >
                <box flexDirection="row" gap={1}>
                  <Show when={q.header}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      [{q.header}]
                    </text>
                  </Show>
                  <text fg={isPast() ? theme.textMuted : theme.text}>{q.question}</text>
                  <Show when={q.multiSelect && isCurrent()}>
                    <text fg={theme.textMuted}>(pick any)</text>
                  </Show>
                  <Show when={isPast()}>
                    <text fg={theme.textMuted}>(click to edit)</text>
                  </Show>
                </box>

                <Show when={isAnswered()}>
                  <box paddingLeft={2}>
                    <text fg={theme.success}>
                      {RESULT_PREFIX}
                      {finalAnswer() && finalAnswer()!.length > 0 ? finalAnswer() : "(no answer)"}
                    </text>
                  </box>
                </Show>
                <Show when={isPast()}>
                  <box paddingLeft={2}>
                    <text fg={theme.textMuted}>
                      {RESULT_PREFIX}
                      {renderedAnswerFor(q).length > 0 ? renderedAnswerFor(q) : "(no answer)"}
                    </text>
                  </box>
                </Show>

                <Show when={isCurrent()}>
                  <box paddingLeft={2} flexDirection="column">
                    <For each={q.options}>
                      {(opt, optIndex) => {
                        const isPicked = () => picked().has(opt.label)
                        const isHl = () => highlighted() === optIndex()
                        const glyph = () => (q.multiSelect ? (isPicked() ? "[x]" : "[ ]") : isPicked() ? "(•)" : "( )")
                        const digitChip = () => (optIndex() < 9 ? `${optIndex() + 1}.` : "  ")
                        return (
                          <box
                            flexDirection="row"
                            gap={1}
                            onMouseUp={() => toggle(q.question, q.multiSelect, opt.label)}
                          >
                            <text fg={isHl() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {isHl() ? ">" : " "}
                            </text>
                            <text fg={theme.textMuted}>{digitChip()}</text>
                            <text fg={isPicked() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {glyph()}
                            </text>
                            <box flexGrow={1} flexDirection="column">
                              <text fg={theme.text}>{opt.label}</text>
                              <Show when={opt.description}>
                                <text fg={theme.textMuted}>{opt.description}</text>
                              </Show>
                            </box>
                          </box>
                        )
                      }}
                    </For>
                    {(() => {
                      const otherPicked = () => picked().has(OTHER_SENTINEL)
                      const otherIdx = q.options.length
                      const isOtherHl = () => highlighted() === otherIdx
                      const otherGlyph = () =>
                        q.multiSelect ? (otherPicked() ? "[x]" : "[ ]") : otherPicked() ? "(•)" : "( )"
                      const otherDigitChip = () => (otherIdx < 9 ? `${otherIdx + 1}.` : "  ")
                      return (
                        <>
                          <box
                            flexDirection="row"
                            gap={1}
                            onMouseUp={() => toggle(q.question, q.multiSelect, OTHER_SENTINEL)}
                          >
                            <text fg={isOtherHl() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {isOtherHl() ? ">" : " "}
                            </text>
                            <text fg={theme.textMuted}>{otherDigitChip()}</text>
                            <text fg={otherPicked() ? theme.accent : theme.textMuted} attributes={TextAttributes.BOLD}>
                              {otherGlyph()}
                            </text>
                            <box flexGrow={1} flexDirection="column">
                              <text fg={theme.text}>Other</text>
                              <text fg={theme.textMuted}>Type your own answer</text>
                            </box>
                          </box>
                          <Show when={otherPicked()}>
                            <box paddingLeft={4} paddingTop={0}>
                              <input
                                value={customTextFor(q.question)}
                                placeholder="type your answer…"
                                focused={true}
                                onInput={(v: string) => setCustomText(q.question, v)}
                                onSubmit={() => advanceOrSubmit()}
                              />
                            </box>
                          </Show>
                        </>
                      )
                    })()}
                    <box paddingLeft={0} paddingTop={1} flexDirection="row" gap={2}>
                      <text
                        fg={isQuestionComplete(index()) ? theme.success : theme.textMuted}
                        attributes={TextAttributes.BOLD}
                        onMouseUp={() => advanceOrSubmit()}
                      >
                        {buttonLabel()}
                      </text>
                      <Show when={!isQuestionComplete(index())}>
                        <text fg={theme.textMuted}>(pick an option to continue)</text>
                      </Show>
                    </box>
                  </box>
                </Show>
              </box>
            </Show>
          )
        }}
      </For>

      <Show when={isAnswered()}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.success} attributes={TextAttributes.BOLD}>
            [submitted]
          </text>
        </box>
      </Show>
    </box>
  )
}
