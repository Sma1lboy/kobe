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

import { render, useRenderer } from "@opentui/solid"
import {
  installClientCrashHandlers,
  logClientError,
  setClientLogContext,
} from "@sma1lboy/kobe-daemon/client/client-log"
import { ErrorBoundary, type JSX, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { FocusProvider } from "../context/focus"
import { applyUserKeybindings, reloadUserKeybindings } from "../context/keybindings-user"
import { KVProvider } from "../context/kv"
import { NotificationsProvider } from "../context/notifications"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { isLocaleId, setLocaleLang, t } from "../i18n"
import { DialogProvider } from "../ui/dialog"
import { type UiPrefsTarget, applyUiPrefs } from "./apply-ui-prefs"
import { sessionAttached } from "./attach-gate"
import { hostRenderOptions, installPaneExitBackstop } from "./host-render-options"
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
   * place (the "daemon client disposed" lesson from the Tasks pane).
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
   * every host already used — and receives the persisted prefs for hosts
   * that key non-visual decisions off them. The VISUAL prefs themselves
   * (theme + transparent + focus accent) are applied centrally by
   * {@link UiPrefsSync} for every host — at boot and live on the daemon's
   * `ui-prefs` channel — so a host never re-applies them itself.
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
  // Process-level crash net, FIRST — before any boot step can spawn a
  // fire-and-forget. Each pane is its own opentui process with no
  // unhandledRejection/uncaughtException handler of its own; the default is
  // to terminate, dropping the pane to a raw shell on a single stray
  // rejected promise. This flips that to a logged-and-survive default
  // (mirrors the daemon's `installDaemonCrashHandlers`). The render tree's
  // own throws are caught separately by the <ErrorBoundary> in bootPaneHost.
  installClientCrashHandlers()
  applyUserKeybindings()
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
}

// Render options + the exit backstop are shared with the React host path —
// see ./host-render-options.ts.

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
 * The themed fallback rendered when the host's view tree throws during render
 * (Solid's `<ErrorBoundary>` catches synchronous render/effect errors — the
 * crash-net `installClientCrashHandlers` covers fire-and-forget rejections,
 * the other half of the same "a pane must not die to a raw shell" goal).
 *
 * It logs the error once (to `client.log`, the only sink visible under tmux's
 * alternate screen) and paints a minimal, theme-aware placeholder instead of
 * letting the process exit. Lives INSIDE `HostProviders`, so `useTheme()` and
 * `t()` are available; kept dependency-light (a plain box of text) so the
 * fallback itself can't throw. Errors during render don't auto-recover, so no
 * `reset` is wired — the user reloads the pane.
 */
function PaneCrashFallback(props: { error: unknown }) {
  const { theme } = useTheme()
  // Log once on mount, not during render (render can re-run; an effect fires
  // exactly once for this mounted fallback).
  onMount(() => logClientError("pane-crash", props.error))
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} paddingLeft={1} paddingTop={1} gap={1}>
      <text fg={theme.error}>{t("common.paneCrash.title")}</text>
      <text fg={theme.textMuted}>{t("common.paneCrash.hint")}</text>
    </box>
  )
}

/**
 * Visual-prefs application, ONCE for every host (KOB — live theme
 * propagation). Mounted by `bootPaneHost` inside the provider nest, ahead
 * of the host's own root:
 *
 *   1. **Boot**: applies the persisted theme + transparent + focus accent
 *      uniformly. This also fixed a drift — new-task / quick-task / update
 *      / ops-preview used to apply only `prefs.theme` while tasks /
 *      settings / ops each hand-applied the other two in their own
 *      `onMount`; all hosts now take all three through one
 *      {@link applyUiPrefs} path.
 *   2. **Live**: opens its OWN non-spawning daemon subscription (a
 *      `role: "pane"` RemoteOrchestrator via `connectPaneOrchestrator`) and
 *      re-applies every `ui-prefs` push, so a Settings appearance change
 *      in ANY session restyles this pane immediately. A dedicated
 *      connection — rather than threading each host's optional
 *      orchestrator through here — keeps this a zero-wiring boot step for
 *      every current and future host (some hosts, like ops, have no primary
 *      orchestrator to thread). It is CHANNEL-SCOPED to
 *      `["ui-prefs", "keybindings"]` (KOB — per-channel subscribe): the
 *      daemon then sends this socket ONLY those two channels, not the full
 *      `task.snapshot` / `engine-state` / `worktree.changes` fan-out a
 *      Tasks pane consumes — so in a host that already has a primary
 *      orchestrator this second socket no longer doubles the per-broadcast
 *      write + JSON.parse of the whole task list it never reads. It never
 *      holds the daemon alive (`role: "pane"`).
 *
 * Degraded mode (accepted): with no daemon running at mount,
 * `connectPaneOrchestrator` yields null and the pane keeps its boot-time
 * prefs — same fallback stance as the Tasks pane's file-poll. A pane that
 * HAD a connection auto-reconnects (RemoteOrchestrator's pane reconnect
 * loop) and the subscribe-time channel replay catches it up.
 *
 * Echo guard: the process that caused a prefs write receives its own push
 * back; `applyUiPrefs` compares before every set, so identical values are
 * a no-op.
 *
 * tmux chrome is deliberately NOT re-applied here — the status/window bar
 * and border options are server-global, so the settings-exit flow's single
 * `refreshKobeWorkspacePanes` → `applyTmuxChromeTheme` call already covers
 * every session; doing it from N panes would just race the same `set-option`s.
 */
/** Detached fps while the pane's session has no attached client. */
const DETACHED_FPS = 2
/** How often to re-check attachment (the probe itself is TTL-cached). */
const DETACH_CHECK_MS = 3000

/**
 * Render-loop throttle for background panes, ONCE for every host (sibling of
 * {@link UiPrefsSync}). The attach gate already stops the pollers; this stops
 * the other half of a detached pane's idle burn — the opentui render loop
 * ticking at full fps for a screen nobody can see. Detached → targetFps drops
 * to {@link DETACHED_FPS}; re-attach restores the boot fps within ~3s (the
 * loop keeps running, so the first restored frame repaints any staleness).
 * Deliberately fps-throttle rather than pause(): the renderer state machine
 * (input, dialogs, suspend semantics) stays untouched, and a gate failure
 * fails open to full fps.
 */
function DetachFpsThrottle() {
  const renderer = useRenderer()
  onMount(() => {
    if (!renderer) return
    const attachedFps = renderer.targetFps
    const timer = setInterval(() => {
      void sessionAttached().then((attached) => {
        const want = attached ? attachedFps : DETACHED_FPS
        if (renderer.targetFps !== want) renderer.targetFps = want
      })
    }, DETACH_CHECK_MS)
    onCleanup(() => clearInterval(timer))
  })
  return null
}

function UiPrefsSync(props: { boot: PersistedUiPrefs }) {
  const themeCtx = useTheme()
  const target: UiPrefsTarget = {
    selectedTheme: () => themeCtx.selected,
    hasTheme: (name) => themeCtx.has(name),
    setTheme: (name) => themeCtx.set(name),
    reloadUserThemes: () => {
      for (const { name, theme } of loadUserThemes()) addTheme(name, theme)
    },
    transparentBackground: () => themeCtx.transparentBackground,
    setTransparentBackground: (v) => themeCtx.setTransparentBackground(v),
    focusAccent: () => themeCtx.focusAccent,
    setFocusAccent: (slot) => themeCtx.setFocusAccent(slot),
    reducedMotion: () => themeCtx.reducedMotion,
    setReducedMotion: (v) => themeCtx.setReducedMotion(v),
  }

  // Boot application, during this component's render — the sibling host
  // root renders after it, so it already sees the applied values (no
  // transparent/accent flash; the theme name itself was also seeded via
  // the ThemeProvider prop, making that branch a no-op here).
  applyUiPrefs(target, {
    theme: props.boot.theme,
    transparentBackground: props.boot.transparent,
    focusAccent: props.boot.focusAccent,
    reducedMotion: props.boot.reducedMotion,
  })
  // Language is a module-global reactive value (not part of the theme
  // target), so it's seeded directly rather than through applyUiPrefs.
  // This covers every host at boot; switching it live in Settings updates
  // the same module store in-process. Cross-pane live propagation rides a
  // later ui-prefs-channel field — for now panes pick up a change on boot.
  setLocaleLang(props.boot.locale)

  // Live subscription. The orchestrator lands in a signal so the effect
  // below — created synchronously under THIS component's owner — starts
  // tracking `uiPrefsSignal()` once the async connect resolves.
  //
  // `connectPaneOrchestrator` owns leak guard (a): a failed handshake
  // disposes the half-built orchestrator (the open socket + the would-be
  // pane reconnect loop) before yielding null, so no consumer-less ghost
  // subscriber survives a protocol skew. It also keeps the NON-spawning
  // rule (a helper must never resurrect an idle-stopped daemon → null when
  // no daemon, the documented degrade). We add leak guard (b): if this
  // component was cleaned up while the connect was still in flight, the
  // late-resolving orchestrator must be disposed on the spot — `onCleanup`
  // already ran and can never see it. CHANNEL-SCOPED to ui-prefs +
  // keybindings so this socket never receives the task fan-out.
  const [prefsOrch, setPrefsOrch] = createSignal<RemoteOrchestrator | null>(null)
  let disposed = false
  onMount(() => {
    void (async () => {
      const remote = await connectPaneOrchestrator({
        logTag: "ui-prefs",
        channels: ["ui-prefs", "keybindings"],
      })
      if (!remote) return
      if (disposed) {
        remote.dispose()
        return
      }
      setPrefsOrch(remote)
    })()
  })
  createEffect(() => {
    const payload = prefsOrch()?.uiPrefsSignal()()
    if (!payload) return
    applyUiPrefs(target, payload)
    // Language rides the same live channel: a switch in any session's
    // Settings re-translates every pane in place (no reboot), the same way
    // theme/transparent/accent already propagate. setLocaleLang is a no-op
    // on an unknown id, so a stale/garbage value never wedges a pane.
    if (isLocaleId(payload.locale)) setLocaleLang(payload.locale)
  })

  // Live keybindings (KOB — cross-session keybinding propagation): the
  // daemon's keybindings watcher bumps a `rev` on the `keybindings` channel
  // whenever keybindings.yaml changes. Re-read + re-apply onto KobeKeymap so
  // this pane's chords (and their legend) update without a session rebuild.
  // Skip the FIRST observed rev — it's the replay of the boot value, already
  // applied by `applyUserKeybindings()` in bootPaneHost; only later bumps are
  // real edits. Same degraded/reconnect stance as the prefs effect above.
  let lastKeybindingsRev: number | null = null
  createEffect(() => {
    const rev = prefsOrch()?.keybindingsRevSignal()()
    if (rev == null) return
    if (lastKeybindingsRev === null || rev === lastKeybindingsRev) {
      lastKeybindingsRev = rev
      return
    }
    lastKeybindingsRev = rev
    reloadUserKeybindings()
  })
  onCleanup(() => {
    disposed = true
    prefsOrch()?.dispose()
  })

  return null
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
        <UiPrefsSync boot={prefs} />
        <DetachFpsThrottle />
        <ErrorBoundary fallback={(err) => <PaneCrashFallback error={err} />}>{screen.root()}</ErrorBoundary>
      </HostProviders>
    ),
    hostRenderOptions(screen.onDestroy),
  )
  installPaneExitBackstop()
}
