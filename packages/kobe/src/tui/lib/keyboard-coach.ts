/** Framework-free state transitions for the one-time keyboard grammar coach. */

export const KEYBOARD_COACH_STEP_KEY = "keybindings.coach.step"
export const KEYBOARD_COACH_DONE = 3

export type KeyboardCoachInput = {
  focused: string
  lastAction: string | null
  lastWasPrefix: boolean
  focusSidebarAvailable: boolean
  prefixAvailable: boolean
}

export function nextKeyboardCoachStep(step: number, input: KeyboardCoachInput): number {
  if (step < 0 || step >= KEYBOARD_COACH_DONE) return KEYBOARD_COACH_DONE
  if (step === 0 && input.focused !== "sidebar") return 1
  if (step === 1 && !input.focusSidebarAvailable) return 2
  if (step === 1 && input.lastAction === "focus.sidebar") return 2
  if (step === 2 && !input.prefixAvailable) return KEYBOARD_COACH_DONE
  if (step === 2 && input.lastWasPrefix && input.lastAction !== null) return KEYBOARD_COACH_DONE
  return step
}
