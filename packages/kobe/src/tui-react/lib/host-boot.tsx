/** @jsxImportSource @opentui/react */
/**
 * Shared boot sequence for kobe's React pane hosts (issue #15, G3) — the
 * `src/tui/lib/host-boot.tsx` counterpart. Same responsibilities, same
 * boot order (log context → crash handlers → keybindings.yaml overlay →
 * user themes → prefs read → per-host setup → provider-wrapped render),
 * with the framework-free pieces (`applyUserKeybindings`, `loadUserThemes`,
 * `readPersistedUiPrefs`, `applyUiPrefs`, `hostRenderOptions`,
 * `installPaneExitBackstop`) imported from the shared modules.
 *
 * Deliberate deltas from the Solid host:
 *   - Visual prefs are seeded into the module-level theme store BEFORE
 *     `createRoot().render()` (the Solid version applies them inside a
 *     sync component during first render) — the first painted frame is
 *     already styled, and no component needs render-time side effects.
 *   - The live daemon subscription rides the client layer's framework-free
 *     store twins (`uiPrefsStore()` / `keybindingsRevStore()`) — Solid
 *     signals don't notify outside a reactive-solid runtime.
 *   - Error boundary is a small class component (React's only boundary
 *     primitive); crash logging + themed fallback match the Solid host.
 *   - Provider flags: only `focus` is portable today. `kv` /
 *     `notifications` have no React port yet — requesting one throws
 *     loudly at boot rather than silently skipping a provider a pane
 *     depends on. They land with the panes that need them (issue #15 G3).
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot, useRenderer } from "@opentui/react"
import {
  installClientCrashHandlers,
  logClientError,
  setClientLogContext,
} from "@sma1lboy/kobe-daemon/client/client-log"
import type { UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { Component, type ReactNode, useEffect } from "react"
import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { applyUserKeybindings, reloadUserKeybindings } from "../../tui/context/keybindings-user"
import { loadUserThemes } from "../../tui/context/theme/loader"
import { type UiPrefsTarget, applyUiPrefs } from "../../tui/lib/apply-ui-prefs"
import { sessionAttached } from "../../tui/lib/attach-gate"
import { hostRenderOptions, installPaneExitBackstop } from "../../tui/lib/host-render-options"
import { type PersistedUiPrefs, readPersistedUiPrefs } from "../../tui/lib/persisted-ui-prefs"
import { FocusProvider } from "../context/focus"
import {
  ThemeProvider,
  addTheme,
  focusAccent,
  hasTheme,
  selectedTheme,
  setFocusAccent,
  setTheme,
  setTransparentBackground,
  transparentBackground,
} from "../context/theme"
import { useTheme } from "../context/theme"
import { isLocaleId, setLocaleLang, t } from "../i18n"
import { DialogProvider } from "../ui/dialog"

/** Theme used when `state.json` is missing/stale — kobe's brand default. */
const FALLBACK_THEME = "claude"

/** Same flag surface as the Solid host; see header for the un-ported pair. */
export interface HostProviderFlags {
  /** KVProvider — NOT PORTED yet; `true` throws at boot. */
  readonly kv?: boolean
  /** FocusProvider, initial pane "sidebar". Default true. */
  readonly focus?: boolean
  /** NotificationsProvider — NOT PORTED yet; `true` throws at boot. */
  readonly notifications?: boolean
}

/** What a host's `setup` hands back once its own pre-render work is done. */
export interface HostScreen {
  /** The host's root view, rendered inside the provider stack. */
  readonly root: () => ReactNode
  /** Teardown on ACTUAL exit (renderer destroy), never at mount-resolve. */
  readonly onDestroy?: () => void
}

export interface BootPaneHostOpts {
  readonly logContext?: string
  readonly providers?: HostProviderFlags
  readonly setup: (prefs: PersistedUiPrefs) => HostScreen | Promise<HostScreen>
}

/** The module-level theme store as a ui-prefs target (shared applyUiPrefs). */
const themeTarget: UiPrefsTarget = {
  selectedTheme,
  hasTheme,
  setTheme,
  reloadUserThemes: () => {
    for (const { name, theme } of loadUserThemes()) addTheme(name, theme)
  },
  transparentBackground,
  setTransparentBackground,
  focusAccent,
  setFocusAccent,
}

/** Detached fps while the pane's session has no attached client. */
const DETACHED_FPS = 2
/** How often to re-check attachment (the probe itself is TTL-cached). */
const DETACH_CHECK_MS = 3000

/**
 * Render-loop throttle for background panes — fps drops to DETACHED_FPS
 * while the tmux session has no attached client, restores within ~3s of
 * re-attach. Same contract and rationale as the Solid host's sibling.
 */
function DetachFpsThrottle() {
  const renderer = useRenderer()
  useEffect(() => {
    if (!renderer) return
    const attachedFps = renderer.targetFps
    const timer = setInterval(() => {
      void sessionAttached().then((attached) => {
        const want = attached ? attachedFps : DETACHED_FPS
        if (renderer.targetFps !== want) renderer.targetFps = want
      })
    }, DETACH_CHECK_MS)
    return () => clearInterval(timer)
  }, [renderer])
  return null
}

/**
 * Live ui-prefs + keybindings subscription — boot values were already
 * seeded before render (see `bootPaneHost`), so this component only owns
 * the daemon channel. Channel-scoped, non-spawning, degrades to boot-time
 * prefs with no daemon; late connects after unmount are disposed on the
 * spot. The first keybindings rev observed is the boot replay — skipped.
 */
function UiPrefsSync() {
  useEffect(() => {
    let disposed = false
    let orch: RemoteOrchestrator | null = null
    const disposers: Array<() => void> = []
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
      orch = remote
      // Framework-free store twins of the client layer's Solid signals —
      // signals don't notify outside a reactive-solid runtime, stores
      // notify everywhere. Deliver the current value eagerly (the
      // subscribe-time channel replay may have landed before we attached).
      const applyPrefs = (payload: UiPrefsPayload | null) => {
        if (!payload) return
        applyUiPrefs(themeTarget, payload)
        if (isLocaleId(payload.locale)) setLocaleLang(payload.locale)
      }
      const prefsStore = remote.uiPrefsStore()
      applyPrefs(prefsStore.get())
      disposers.push(prefsStore.subscribe(() => applyPrefs(prefsStore.get())))

      const revStore = remote.keybindingsRevStore()
      // The first observed rev is the boot replay — already applied by
      // applyUserKeybindings in bootPaneHost; only later bumps are edits.
      let lastKeybindingsRev: number | null = revStore.get()
      disposers.push(
        revStore.subscribe(() => {
          const rev = revStore.get()
          if (rev == null || rev === lastKeybindingsRev) return
          const isFirst = lastKeybindingsRev === null
          lastKeybindingsRev = rev
          if (!isFirst) reloadUserKeybindings()
        }),
      )
    })()
    return () => {
      disposed = true
      for (const dispose of disposers) dispose()
      orch?.dispose()
    }
  }, [])
  return null
}

/** Themed crash fallback — logs once, paints a minimal placeholder. */
function PaneCrashFallback(props: { error: unknown }) {
  const { theme } = useTheme()
  useEffect(() => {
    logClientError("pane-crash", props.error)
  }, [props.error])
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} paddingLeft={1} paddingTop={1} gap={1}>
      <text fg={theme.error}>{t("common.paneCrash.title")}</text>
      <text fg={theme.textMuted}>{t("common.paneCrash.hint")}</text>
    </box>
  )
}

/**
 * React's boundary primitive is still a class component. Catches render
 * errors from the host's view tree; fire-and-forget rejections are covered
 * by `installClientCrashHandlers`, same split as the Solid host.
 */
class PaneErrorBoundary extends Component<{ children?: ReactNode }, { error: unknown | null }> {
  override state: { error: unknown | null } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override render() {
    if (this.state.error !== null) return <PaneCrashFallback error={this.state.error} />
    return this.props.children
  }
}

/**
 * Boot a standalone React pane host: shared steps → prefs read + seed →
 * per-host `setup` → provider-wrapped `createRoot().render()`. Resolves
 * once the root is mounted, mirroring the Solid host's render-resolve.
 */
export async function bootPaneHost(opts: BootPaneHostOpts): Promise<void> {
  if (opts.logContext) setClientLogContext(opts.logContext)
  installClientCrashHandlers()
  applyUserKeybindings()
  for (const { name, theme } of loadUserThemes()) addTheme(name, theme)

  const prefs = readPersistedUiPrefs(FALLBACK_THEME)
  // Seed ALL visual prefs + language before the first render — the module
  // store is live before any component mounts, so the first frame is
  // already themed (no transparent/accent flash).
  applyUiPrefs(themeTarget, {
    theme: prefs.theme,
    transparentBackground: prefs.transparent,
    focusAccent: prefs.focusAccent,
  })
  setLocaleLang(prefs.locale)

  if (opts.providers?.kv) throw new Error("bootPaneHost(react): KVProvider is not ported yet (issue #15 G3)")
  if (opts.providers?.notifications)
    throw new Error("bootPaneHost(react): NotificationsProvider is not ported yet (issue #15 G3)")
  const focus = opts.providers?.focus ?? true

  const screen = await opts.setup(prefs)
  const renderer = await createCliRenderer(hostRenderOptions(screen.onDestroy))

  const body = (
    <>
      <UiPrefsSync />
      <DetachFpsThrottle />
      <PaneErrorBoundary>{screen.root()}</PaneErrorBoundary>
    </>
  )
  createRoot(renderer).render(
    <ThemeProvider mode="dark" theme={prefs.theme}>
      {focus ? (
        <FocusProvider initial="sidebar">
          <DialogProvider>{body}</DialogProvider>
        </FocusProvider>
      ) : (
        <DialogProvider>{body}</DialogProvider>
      )}
    </ThemeProvider>,
  )
  installPaneExitBackstop()
}
