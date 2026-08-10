/**
 * Pure dispatch logic for kobe's TUI keymap.
 *
 * Kept framework-free so unit tests can exercise the binding-stack
 * precedence + preventDefault behavior without pulling in the renderer.
 * The React hook + renderer-install side lives in
 * `src/tui-react/lib/keymap.ts` and re-exports from here for the rest
 * of the codebase.
 */

import type { KeyEvent } from "@opentui/core"
import { isDev } from "../../env.ts"
import { type PrefixHudOption, prefixHudPush, prefixHudSetArmed } from "./prefix-hud"

export type Binding = {
  key: string
  /** True when `key` is the second stroke of the PureTUI prefix. */
  prefix?: boolean
  /** Terminal/shell input that must win over Kobe's configurable prefix. */
  passthrough?: boolean
  /**
   * Owning KobeKeymap binding id (`tab.new`) — `bindByIds` fills it in so
   * the prefix HUD can name what a resolved sequence did. Hand-rolled
   * `{ key, cmd }` literals may omit it.
   */
  id?: string
  /**
   * Handler. The second argument is the binding's {@link Binding.slot} —
   * present when the registration site assigned one (`bindByIds` does).
   * Single-chord handlers can ignore it; multiplexed handlers (one id,
   * several chords, direction decided by WHICH chord fired) read it
   * instead of `event.name`, so user-rebound chords keep working.
   */
  cmd: (event: KeyEvent, slot?: number) => void
  /**
   * Positional index of `key` within the owning binding id's `keys` array
   * at registration time (slot-based dispatch). `bindByIds` fills this in;
   * hand-rolled `{ key, cmd }` literals may omit it. The slot is what lets
   * a handler like `sidebar.nav` map "which chord fired" → "which
   * direction" without inspecting `event.name` — the contract that makes
   * direction-multiplexed ids user-rebindable (see SLOT_CONTRACTS in
   * keymap-overrides.ts for the per-id slot layouts).
   */
  slot?: number
}

export type BindingsConfig = {
  enabled?: boolean
  /**
   * Modal barrier: when this entry is reached and none of ITS bindings
   * matched, the walk STOPS — every entry registered below (i.e. before
   * this one mounted) is unreachable. `preventDefault` is NOT called on
   * the way out, so opentui's native routing (a dialog's focused text
   * input) still receives the key. This is the structural guarantee that
   * an open dialog can never operate the UI behind it — bindings inside
   * the dialog mount after the barrier and stay reachable; everything
   * older is cut off wholesale instead of each pane gating itself.
   */
  modal?: boolean
  bindings: Binding[]
}

export type RegisteredBinding = {
  config: () => BindingsConfig
  id: number
  /**
   * Modal-scope declaration (static, set at registration — unlike `config`,
   * never re-read per keypress). Together with {@link insertRegistration}
   * this makes barrier-vs-body precedence a function of DECLARED DATA
   * instead of registration (React effect-commit) order:
   *   - `modalOwner`: this entry IS the modal barrier for that scope token.
   *     Its `config()` should also return `modal: true` — the owner field
   *     governs stack POSITION, `config.modal` governs the dispatch cut-off.
   *   - `modalMember`: this entry belongs INSIDE that scope (a dialog
   *     body's bindings) and must stay reachable above the barrier.
   */
  modalOwner?: symbol
  modalMember?: symbol
}

/**
 * Insert a registration into the live binding stack. Plain entries push
 * (LIFO, unchanged). A modal OWNER (barrier) is inserted BELOW the lowest
 * already-registered MEMBER of its scope, so members win over the barrier
 * and the barrier still cuts off everything older — regardless of whether
 * React committed the body's effects before or after the barrier's. This
 * is the explicit contract that used to be an effect-commit-order accident
 * (see tui-react/ui/dialog.tsx). O(n) only at mount/unmount, never on the
 * per-keypress dispatch path.
 */
export function insertRegistration(stack: RegisteredBinding[], reg: RegisteredBinding): void {
  if (reg.modalOwner !== undefined) {
    const firstMember = stack.findIndex((r) => r.modalMember === reg.modalOwner)
    if (firstMember >= 0) {
      stack.splice(firstMember, 0, reg)
      return
    }
  }
  stack.push(reg)
}

/**
 * Build a normalized match key for a `KeyEvent`. Mirrors the chord shape
 * opencode bindings use ("ctrl+c", "shift+tab", "k").
 */
export function matchKey(evt: KeyEvent): string[] {
  // opentui's KeyEvent has `name` (e.g. "k", "escape", "return") plus modifier
  // booleans. We build a few candidate strings so a binding registered as
  // either "return" or "enter" still fires; opencode dialogs use both names.
  const base: string[] = []
  const name = evt.name
  if (name) base.push(name)
  if (name === "return") base.push("enter")
  if (name === "enter") base.push("return")

  // Legacy C0 fallback (issue #192). Terminals without the kitty keyboard
  // protocol (macOS Terminal.app) send ctrl+h as raw 0x08 and ctrl+j as raw
  // 0x0a, which opentui's legacy parser surfaces as {name:"backspace"} /
  // {name:"linefeed"} with ctrl=false — so `ctrl+h`/`ctrl+j` chords (pane
  // focus) were dead there while ctrl+k/ctrl+l (0x0b/0x0c) worked. Alias the
  // two ambiguous bytes back to their chord names. The real Backspace key
  // sends 0x7f, so it never aliases; a terminal configured to "Backspace
  // sends ^H" trades deletion for pane focus, same as kitty-mode terminals.
  if (name === "backspace" && evt.raw === "\b" && !evt.meta && !evt.option) base.push("ctrl+h")
  if (name === "linefeed" && !evt.meta && !evt.option) base.push("ctrl+j")

  // Modifier mapping rules (the *only* place chord prefixes are minted):
  //   - `evt.ctrl`   → `ctrl+`. Universal across terminals.
  //   - `evt.meta`   → `cmd+`. The Command key on macOS / Win key on Windows.
  //                    Most terminals do NOT forward this — Cmd+C is normally
  //                    eaten by the terminal emulator itself for native copy.
  //                    Kitty / Ghostty / iTerm2 *can* be configured to forward
  //                    it; when they do, kobe sees `meta=true`. We keep `cmd+`
  //                    as a separate prefix from `alt+` so a Cmd+X chord that
  //                    leaks into the app doesn't accidentally fire an
  //                    Option+X binding (the previous code aliased both to
  //                    `alt+`, which made `cmd+p`/`cmd+k` bindings in
  //                    KobeKeymap silently dead — KOB key-routing fix).
  //   - `evt.option` → `alt+`. Option on macOS / Alt elsewhere. macOS Option+K
  //                    arrives as `ESC k` which opentui surfaces as
  //                    `option=true`, name=`k` → `alt+k`.
  //   - shift+letter arrives as `{name:"z", shift:true}` (both the legacy
  //     and kitty parser paths). With NO other modifier we mint `shift+z`
  //     FIRST and plain `z` as a FALLBACK candidate, so `Z` can be bound
  //     apart from `z` while every existing bare-letter binding (and the
  //     evt.shift-discriminating handlers) keeps catching uppercase.
  //     Candidate ORDER is the precedence contract — dispatch tries
  //     `shift+z` against a whole bindings entry before falling back.
  //     With ctrl/cmd/alt also held, shift on a single char stays DROPPED:
  //     legacy terminals send ctrl+shift+z and ctrl+z as the same C0 byte,
  //     so such chords would only fire on kitty-protocol terminals.
  const mods: string[] = []
  if (evt.ctrl) mods.push("ctrl")
  if (evt.meta) mods.push("cmd")
  if (evt.option) mods.push("alt")
  const bareShiftChar = evt.shift && name !== undefined && name.length === 1 && mods.length === 0
  if (evt.shift && name && name.length > 1) mods.push("shift")

  if (mods.length === 0) {
    if (bareShiftChar) return [...base.map((n) => `shift+${n}`), ...base]
    return base
  }
  const prefix = `${mods.join("+")}+`
  // When modifiers are present, return ONLY the prefixed forms. A plain
  // `{ key: "k" }` binding must NOT catch `ctrl+k` — otherwise pane-local
  // bindings (sidebar j/k) shadow global chords (`ctrl+k` palette).
  // Bindings that want both behaviors must register both keys explicitly.
  return base.map((n) => prefix + n)
}

/**
 * Re-entrancy guard. A binding's `cmd()` runs synchronously and can mount /
 * unmount React components, which in turn synchronously dispatch their own
 * key events (rare, but possible — e.g. a handler that programmatically
 * pushes a key into the renderer). A nested dispatch would scan a stack that
 * the outer dispatch's handler is in the middle of mutating, firing a chord
 * against a half-applied / wrong-scope set of bindings. We drop nested
 * dispatches: a single physical keypress should resolve to at most one
 * binding. In normal (non-re-entrant) use this flag is always false at entry,
 * so the guard is a no-op and observed behavior is unchanged.
 */
let dispatching = false

export type PrefixConfiguration = {
  /** First stroke; null disables PureTUI prefix dispatch. */
  key: string | null
  /** Maximum elapsed milliseconds between the two strokes. */
  timeoutMs: number
}

export type BindingReachability = {
  direct: ReadonlySet<string>
  prefix: ReadonlySet<string>
  /** An enabled terminal passthrough table owns the current input surface. */
  inputPassthrough: boolean
}

export const DEFAULT_PREFIX_CONFIGURATION: Readonly<PrefixConfiguration> = { key: "ctrl+a", timeoutMs: 5000 }

let prefixConfiguration: PrefixConfiguration = { ...DEFAULT_PREFIX_CONFIGURATION }
let prefixArmedAt: number | null = null
let prefixTimer: ReturnType<typeof setTimeout> | null = null

/** Apply a validated configuration and cancel an in-flight sequence. */
export function configurePrefix(next: PrefixConfiguration): void {
  prefixConfiguration = { ...next }
  resetPrefixState()
}

/** Restore the built-in PureTUI prefix configuration. */
export function resetPrefixConfiguration(): void {
  prefixConfiguration = { ...DEFAULT_PREFIX_CONFIGURATION }
  resetPrefixState()
}

/** Current PureTUI prefix configuration for help and shortcut displays. */
export function currentPrefixConfiguration(): Readonly<PrefixConfiguration> {
  return prefixConfiguration
}

/** Cancel a prefix sequence when reload, a modal, or teardown intervenes. */
export function resetPrefixState(): void {
  if (prefixTimer !== null) clearTimeout(prefixTimer)
  prefixTimer = null
  prefixArmedAt = null
  prefixHudSetArmed(false)
}

function armPrefix(now: number, options: readonly PrefixHudOption[]): void {
  resetPrefixState()
  prefixArmedAt = now
  prefixTimer = setTimeout(resetPrefixState, prefixConfiguration.timeoutMs)
  prefixHudSetArmed(true, options, now)
}

/**
 * Arm the PureTUI prefix programmatically — the mouse path into the command
 * layer (the footer's "commands" hint is clickable). Same guards as the
 * keyboard arm branch in {@link dispatchKeyEvent}: a disabled prefix, an
 * input surface owned by the terminal passthrough, or an unreachable
 * catalogue (modal barrier) is a no-op — the guide must never show commands
 * a second stroke couldn't fire. Returns whether it armed; the armed state
 * is the real one, so the next keypress dispatches as a second stroke.
 */
export function armPrefixNow(snapshot: readonly RegisteredBinding[], now: number = Date.now()): boolean {
  if (prefixConfiguration.key === null) return false
  if (inputPassthroughReachable(snapshot)) return false
  if (!prefixReachable(snapshot)) return false
  armPrefix(now, reachablePrefixOptions(snapshot))
  return true
}

/** Chords already flagged by the shadowed-match warning (once per process
 *  per chord — a stuck contract violation must not spam every keypress). */
const shadowWarned = new Set<string>()

/**
 * Contract check behind the ctrl+w-class bug (split-close vs tab-close):
 * two ENABLED entries matching the same chord means LIFO order — React's
 * effect-order registration puts ancestors on top (see
 * tui-react/lib/keymap.ts) — silently picks the winner. The rule is
 * mutual GATING (exactly one enabled at a time); a second enabled match
 * is a latent bug, so surface it. Runs on the pre-`cmd` snapshot (the
 * handler may re-gate the loser) and respects modal barriers: everything
 * below a modal entry is deliberately unreachable, not shadowed.
 *
 * DEV-ONLY (`isDev()` — KOBE_DEV=1, set by every dev/dev:sandbox/dev:mock
 * script): the scan reads every lower group config, which would break
 * dispatch's read-one-config-on-hit budget on the per-keypress hot path
 * (test/tui/perf-budgets.test.ts).
 */
function warnShadowedMatch(
  snapshot: readonly RegisteredBinding[],
  hitIndex: number,
  candidates: string[],
  prefix: boolean,
): void {
  for (let j = hitIndex - 1; j >= 0; j--) {
    const cfg = snapshot[j]?.config()
    if (!cfg || cfg.enabled === false) continue
    const shadowed = cfg.bindings.find((b) => Boolean(b.prefix) === prefix && candidates.includes(b.key))
    if (shadowed) {
      if (!shadowWarned.has(shadowed.key)) {
        shadowWarned.add(shadowed.key)
        console.error(
          `[kobe keymap] "${shadowed.key}" matched two ENABLED bindings — the lower one is shadowed by LIFO order. Gate one of them off (see tui-react/lib/keymap.ts header).`,
        )
      }
      return
    }
    if (cfg.modal) return
  }
}

/** Whether an enabled prefix row is reachable above the modal barrier. */
function prefixReachable(snapshot: readonly RegisteredBinding[]): boolean {
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const cfg = snapshot[i]?.config()
    if (!cfg || cfg.enabled === false) continue
    if (cfg.bindings.some((binding) => binding.prefix === true)) return true
    if (cfg.modal) return false
  }
  return false
}

/** True when the current focused input surface forwards keys to a PTY. */
function inputPassthroughReachable(snapshot: readonly RegisteredBinding[]): boolean {
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const cfg = snapshot[i]?.config()
    if (!cfg || cfg.enabled === false) continue
    if (cfg.bindings.some((binding) => binding.passthrough)) return true
    if (cfg.modal) return false
  }
  return false
}

/**
 * Snapshot the prefix command map using the same LIFO + modal reachability
 * rules as dispatch. A duplicated stroke appears once and names the action
 * that would actually win right now.
 */
function reachablePrefixOptions(snapshot: readonly RegisteredBinding[]): PrefixHudOption[] {
  const options: PrefixHudOption[] = []
  const seen = new Set<string>()
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const cfg = snapshot[i]?.config()
    if (!cfg || cfg.enabled === false) continue
    for (const binding of cfg.bindings) {
      if (binding.prefix !== true || seen.has(binding.key)) continue
      seen.add(binding.key)
      options.push({ stroke: binding.key, action: binding.id ?? binding.key })
    }
    if (cfg.modal) break
  }
  return options
}

/** Binding ids available above the active modal barrier right now. */
export function bindingReachability(snapshot: readonly RegisteredBinding[]): BindingReachability {
  const direct = new Set<string>()
  const prefix = new Set<string>()
  let inputPassthrough = false
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const cfg = snapshot[i]?.config()
    if (!cfg || cfg.enabled === false) continue
    for (const binding of cfg.bindings) {
      if (binding.passthrough) inputPassthrough = true
      if (!binding.id) continue
      ;(binding.prefix === true ? prefix : direct).add(binding.id)
    }
    if (cfg.modal) break
  }
  return { direct, prefix, inputPassthrough }
}

/** Match one Binding Stack mode, preserving normal LIFO and modal semantics. */
function dispatchMode(
  snapshot: readonly RegisteredBinding[],
  evt: KeyEvent,
  candidates: string[],
  prefix: boolean,
  accepts: (binding: Binding) => boolean = () => true,
): Binding | null {
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const reg = snapshot[i]
    if (!reg) continue
    const cfg = reg.config()
    if (cfg.enabled === false) continue
    // Candidate ORDER is a precedence contract: matchKey lists the most
    // specific form first (`shift+z` before the bare `z` fallback), so an
    // entry holding both a `shift+z` and a `z` binding must fire the
    // shift-specific one — registration order within the entry must not
    // decide. Candidates are ≤3 strings, so the nested scan stays O(1).
    let hit: Binding | undefined
    for (const candidate of candidates) {
      hit = cfg.bindings.find(
        (binding) => Boolean(binding.prefix) === prefix && binding.key === candidate && accepts(binding),
      )
      if (hit) break
    }
    if (hit) {
      if (!cfg.modal && isDev()) warnShadowedMatch(snapshot, i, candidates, prefix)
      hit.cmd(evt, hit.slot)
      return hit
    }
    if (cfg.modal) return null
  }
  return null
}

/**
 * Walk the binding stack top-down and fire the first matching binding.
 * Returns true if a binding was fired (caller can inspect this; the
 * production listener uses it to short-circuit). On a hit, the event's
 * `preventDefault()` is called so opentui's native widgets (e.g. the
 * textarea's onSubmit) don't also receive the key in the same tick.
 *
 * The scan runs over a STABLE SNAPSHOT of `bindingStack` taken at entry. A
 * matched handler's `cmd()` can synchronously mutate the live stack (React
 * mount/cleanup effects push/remove entries — see `useBindings` in
 * `src/tui-react/lib/keymap.ts`);
 * iterating the live array would let those mid-flight mutations skip or
 * double-visit entries. Snapshotting insulates the in-progress scan without
 * changing precedence: the same top-down (LIFO) order is searched and the
 * same binding wins.
 */
export function dispatchKeyEvent(
  bindingStack: readonly RegisteredBinding[],
  evt: {
    defaultPrevented: boolean
    preventDefault(): void
    name?: string
    raw?: string
    ctrl?: boolean
    meta?: boolean
    option?: boolean
    shift?: boolean
  },
  now = Date.now(),
): boolean {
  if (evt.defaultPrevented || dispatching) return false
  const snapshot = bindingStack.slice()
  const candidates = matchKey(evt as KeyEvent)
  dispatching = true
  try {
    // A sequence armed in another pane cannot cross the terminal boundary:
    // once PTY passthrough owns input, cancel it and dispatch this key using
    // the current surface instead.
    if (prefixArmedAt !== null && inputPassthroughReachable(snapshot)) resetPrefixState()
    if (prefixArmedAt !== null) {
      const armedPrefixKey = prefixConfiguration.key ?? ""
      const expired = now - prefixArmedAt > prefixConfiguration.timeoutMs
      prefixArmedAt = null
      if (expired) {
        resetPrefixState()
      } else {
        // Escape cancels an armed sequence instead of also closing a dialog.
        if (candidates.includes("escape")) {
          resetPrefixState()
          evt.preventDefault()
          return true
        }
        // A miss is consumed so it cannot type into an input or Terminal pane
        // after the user deliberately started a prefix sequence.
        resetPrefixState()
        const hit = dispatchMode(snapshot, evt as KeyEvent, candidates, true)
        prefixHudPush({
          prefixKey: armedPrefixKey,
          stroke: candidates[0] ?? "",
          action: hit ? (hit.id ?? hit.key) : null,
          at: now,
        })
        evt.preventDefault()
        return true
      }
    }

    if (prefixConfiguration.key !== null && candidates.includes(prefixConfiguration.key)) {
      // The embedded terminal owns unreserved input, including the prefix
      // first stroke. Its explicit passthrough row must win before the
      // global prefix catalogue can arm.
      const passthrough = dispatchMode(snapshot, evt as KeyEvent, candidates, false, (binding) =>
        Boolean(binding.passthrough),
      )
      if (passthrough) {
        evt.preventDefault()
        return true
      }
      if (prefixReachable(snapshot)) {
        armPrefix(now, reachablePrefixOptions(snapshot))
        evt.preventDefault()
        return true
      }
    }

    const direct = dispatchMode(snapshot, evt as KeyEvent, candidates, false)
    if (direct) {
      // Direct chords land in the HUD too — but only REAL modifier chords
      // (ctrl+t, alt+…): plain pane letters (sidebar j/k) would stream
      // noise on every navigation keypress, and shift+letter is just
      // typing an uppercase character (terminal passthrough included) —
      // same noise class as the bare letters.
      if (direct.id && direct.key.includes("+") && !direct.key.startsWith("shift+")) {
        prefixHudPush({ prefixKey: "", stroke: direct.key, action: direct.id ?? direct.key, at: now })
      }
      evt.preventDefault()
      return true
    }
    return false
  } finally {
    dispatching = false
  }
}
