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
 *   - Provider flags: `kv`, `focus`, and `notifications` are all portable
 *     now. Unlike the Solid host, `kv` defaults to FALSE here: every
 *     existing React pane opted in explicitly, so mounting KV implicitly
 *     would silently change them.
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import {
  installClientCrashHandlers,
  logClientError,
  setClientLogContext,
} from "@sma1lboy/kobe-daemon/client/client-log"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { Component, type ReactNode, useEffect } from "react"
import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { applyUserKeybindings, reloadUserKeybindings } from "../../tui/context/keybindings-user"
import { loadUserThemes } from "../../tui/context/theme/loader"
import { type UiPrefsTarget, applyUiPrefs } from "../../tui/lib/apply-ui-prefs"
import { installEventLoopStallTelemetry } from "../../tui/lib/event-loop-stall"
import {
  hostRenderOptions,
  installOrphanExitWatchdog,
  installPaneExitBackstop,
} from "../../tui/lib/host-render-options"
import { type PersistedUiPrefs, readPersistedUiPrefs } from "../../tui/lib/persisted-ui-prefs"
import { FocusProvider } from "../context/focus"
import { KVProvider } from "../context/kv"
import { NotificationsProvider } from "../context/notifications"
import {
  ThemeProvider,
  addTheme,
  focusAccent,
  hasTheme,
  reducedMotion,
  selectedTheme,
  setFocusAccent,
  setReducedMotion,
  setTheme,
  setTransparentBackground,
  transparentBackground,
} from "../context/theme"
import { useTheme } from "../context/theme"
import { isLocaleId, setLocaleLang, t } from "../i18n"
import { DialogProvider } from "../ui/dialog"

/** Theme used when `state.json` is missing/stale — kobe's brand default. */
const FALLBACK_THEME = "claude"

/** Same flag surface as the Solid host; see header for the un-ported one. */
export interface HostProviderFlags {
  /** KVProvider (persisted UI state). Default false — see header. */
  readonly kv?: boolean
  /** FocusProvider, initial pane "sidebar". Default true. */
  readonly focus?: boolean
  /** NotificationsProvider (toast queue). Default false. */
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
  reducedMotion,
  setReducedMotion,
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
    reducedMotion: prefs.reducedMotion,
  })
  setLocaleLang(prefs.locale)

  const kv = opts.providers?.kv ?? false
  const focus = opts.providers?.focus ?? true
  const notifications = opts.providers?.notifications ?? false

  const screen = await opts.setup(prefs)
  const renderer = await createCliRenderer(hostRenderOptions(screen.onDestroy))

  const body = (
    <>
      <UiPrefsSync />
      <PaneErrorBoundary>{screen.root()}</PaneErrorBoundary>
    </>
  )
  // Same fixed nesting order as the Solid host:
  // Theme > KV > Focus > Dialog > Notifications; only membership varies.
  const withNotifications = notifications ? <NotificationsProvider>{body}</NotificationsProvider> : body
  const withDialog = <DialogProvider>{withNotifications}</DialogProvider>
  const withFocus = focus ? <FocusProvider initial="sidebar">{withDialog}</FocusProvider> : withDialog
  const withKv = kv ? <KVProvider>{withFocus}</KVProvider> : withFocus
  createRoot(renderer).render(
    <ThemeProvider mode="dark" theme={prefs.theme}>
      {withKv}
    </ThemeProvider>,
  )
  installPaneExitBackstop()
  installOrphanExitWatchdog()
  installEventLoopStallTelemetry()
}

/**
 * Best-effort daemon connection for a page host (new-task / quick-task):
 * the page still renders without a daemon — mutations are unavailable and
 * the failure is log-only. Hosts that REQUIRE the daemon (the workspace
 * host's gui attach) keep their own throwing connect.
 */
export async function connectOrchestratorBestEffort(logContext: string): Promise<RemoteOrchestrator | null> {
  // SPAWNING on purpose — the injected connect boots the daemon if needed
  // (a page host is a gui-adjacent surface, not a helper pane). The seam
  // still owns the init sequence, logs the failure cause under `logContext`,
  // and disposes a half-built orchestrator instead of leaking it.
  const orch = await connectPaneOrchestrator({ logTag: logContext, connect: connectOrStartDaemon })
  if (!orch) console.error(`[kobe ${logContext}] daemon unavailable; cannot create task`)
  return orch
}
