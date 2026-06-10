/**
 * Shared boot sequence for kobe's standalone TUI hosts.
 *
 * Every `kobe <pane>` subcommand (Tasks pane, Ops pane + preview, new-task,
 * quick-task, settings, update page) is its own OS process with its own
 * opentui render loop, and each one used to open with the same ~35-line
 * block: `applyUserKeybindings()`, the `loadUserThemes()` → `addTheme` loop,
 * `readPersistedUiPrefs("claude")`, a ThemeProvider/KVProvider/FocusProvider/
 * DialogProvider nest, and a `render(..., {options})` call whose option set
 * was identical in all of them. That meant every new boot step was a 7-file
 * patch — `applyUserKeybindings` (the keybindings.yaml overlay) being the
 * latest example: it had to be hand-threaded into each host one by one, and
 * a missed host silently ignores the user's overrides. This module is that
 * block, once.
 *
 * What stays per-host (the genuine differences):
 *   - the root component, and any async setup before render (daemon
 *     connect, tasks.json load, context resolution) — `setup` callback;
 *   - which providers the host needs — `providers` flags (ops panes skip
 *     KV/Focus; only the Tasks pane mounts Notifications + ToastOverlay);
 *   - `onDestroy` teardown (daemon client dispose, poll timers);
 *   - `setClientLogContext` tag, for the panes that log via the daemon.
 *
 * NOTE for tests: this module (transitively) imports @opentui, which is not
 * importable under node/vitest (its package ships raw `.scm` tree-sitter
 * assets). Don't import it from unit tests; pure logic that needs coverage
 * must live elsewhere.
 */

import { render } from "@opentui/solid"
import { setClientLogContext } from "@sma1lboy/kobe-daemon/client/client-log"
import type { JSX } from "solid-js"
import { FocusProvider } from "../context/focus"
import { applyUserKeybindings } from "../context/keybindings-user"
import { KVProvider } from "../context/kv"
import { NotificationsProvider } from "../context/notifications"
import { ThemeProvider, addTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { DialogProvider } from "../ui/dialog"
import { type PersistedUiPrefs, readPersistedUiPrefs } from "./persisted-ui-prefs"

/**
 * Theme used when `state.json` is missing/stale. "claude" is kobe's brand
 * default (same as app.tsx's DEFAULT_THEME) — every host used this exact
 * fallback, so it's a module constant, not a per-host knob.
 */
const FALLBACK_THEME = "claude"

/**
 * Which providers a host mounts around its root. The nesting ORDER is fixed
 * (Theme > KV > Focus > Dialog > Notifications) — it's the order every pane
 * host already used; only membership varies:
 *   - ops / ops --preview run with `{ kv: false, focus: false }` (FileTree
 *     and the read-only preview never touch KV or pane focus);
 *   - the Tasks pane is the only host with `notifications: true` (its error
 *     toasts replace console.error, which is invisible under tmux's
 *     alternate screen).
 * Theme and Dialog are unconditional: every host themes itself and every
 * host can show at least a confirm dialog.
 */
export interface HostProviderFlags {
  /** KVProvider (persisted UI state). Default true. */
  readonly kv?: boolean
  /** FocusProvider, initial pane "sidebar" (every host that mounts it uses "sidebar"). Default true. */
  readonly focus?: boolean
  /** NotificationsProvider (toast queue). Default false. */
  readonly notifications?: boolean
}

/** What a host's `setup` hands back once its own pre-render work is done. */
export interface HostScreen {
  /** The host's root view, rendered inside the provider stack. */
  readonly root: () => JSX.Element
  /**
   * Teardown on ACTUAL exit. opentui's `render` resolves at mount, so
   * disposing after `await render(...)` would kill daemon clients / poll
   * timers the moment the pane comes up — `onDestroy` is the only correct
   * place (the KOB-247 "daemon client disposed" lesson from the Tasks pane).
   */
  readonly onDestroy?: () => void
}

export interface BootPaneHostOpts {
  /**
   * `setClientLogContext` tag so this pane's client-log lines carry a
   * subsystem name. Only the long-lived in-session panes (tasks, ops) set
   * one today; transient pages (new-task, settings, …) never did — omit to
   * preserve that.
   */
  readonly logContext?: string
  readonly providers?: HostProviderFlags
  /**
   * Per-host pre-render work (daemon connect, store load, context
   * resolution). Runs AFTER the boot steps and the prefs read — same order
   * every host already used — and receives the persisted prefs so the host
   * can thread `transparent` / `focusAccent` into its shell. Hosts that
   * ignore those prefs today (new-task, quick-task, update, preview) keep
   * ignoring them; applying them centrally would be a behavior change.
   */
  readonly setup: (prefs: PersistedUiPrefs) => HostScreen | Promise<HostScreen>
}

/**
 * The pre-render steps every host runs, in the order they always ran:
 * log-context tag (when given) → keybindings.yaml overlay → user themes.
 * Every host goes through here via `bootPaneHost`, so a future boot step
 * is a one-line addition instead of an 8-host patch.
 */
function applyHostBootSteps(logContext?: string): void {
  if (logContext) setClientLogContext(logContext)
  applyUserKeybindings()
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
}

/**
 * The render-option set shared by every host, verbatim from the blocks this
 * module replaced: transparent background (the terminal's own bg shows
 * through), passthrough external output, no exit-on-Ctrl+C (hosts own their
 * quit semantics), alternate screen, kitty keyboard protocol. `onDestroy`
 * is the only delta any host ever had; it's spread in only when present so
 * a host without teardown passes the exact same shape as before.
 */
function hostRenderOptions(onDestroy?: () => void): Record<string, unknown> {
  const base = {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  }
  return onDestroy ? { ...base, onDestroy } : base
}

/**
 * The fixed-order provider nest. Built innermost-out as NAMED closures:
 * Solid evaluates JSX children lazily (compiled getters), so each layer must
 * close over a stable binding — a reassigned `let tree` would make a layer's
 * getter see its own wrapper and recurse. Flags are static for the process
 * lifetime, so plain conditionals (no <Show>) are correct here.
 */
function HostProviders(props: {
  theme: string
  kv: boolean
  focus: boolean
  notifications: boolean
  children: JSX.Element
}) {
  const leaf = () => props.children
  const withNotifications = () =>
    props.notifications ? <NotificationsProvider>{leaf()}</NotificationsProvider> : leaf()
  const withDialog = () => <DialogProvider>{withNotifications()}</DialogProvider>
  const withFocus = () => (props.focus ? <FocusProvider initial="sidebar">{withDialog()}</FocusProvider> : withDialog())
  const withKv = () => (props.kv ? <KVProvider>{withFocus()}</KVProvider> : withFocus())
  return (
    <ThemeProvider mode="dark" theme={props.theme}>
      {withKv()}
    </ThemeProvider>
  )
}

/**
 * Boot a standalone pane host: shared steps → prefs read → per-host `setup`
 * → provider-wrapped `render`. Resolves when `render` resolves (at mount),
 * exactly like the inline blocks it replaced.
 */
export async function bootPaneHost(opts: BootPaneHostOpts): Promise<void> {
  applyHostBootSteps(opts.logContext)
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)
  const screen = await opts.setup(prefs)
  const kv = opts.providers?.kv ?? true
  const focus = opts.providers?.focus ?? true
  const notifications = opts.providers?.notifications ?? false
  await render(
    () => (
      <HostProviders theme={prefs.theme} kv={kv} focus={focus} notifications={notifications}>
        {screen.root()}
      </HostProviders>
    ),
    hostRenderOptions(screen.onDestroy),
  )
}
