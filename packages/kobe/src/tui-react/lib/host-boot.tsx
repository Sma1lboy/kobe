/** @jsxImportSource @opentui/react */

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
import { KVProvider } from "../context/kv"
import { NotificationsProvider } from "../context/notifications"
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

const FALLBACK_THEME = "claude"

export interface HostProviderFlags {
  readonly kv?: boolean
  readonly focus?: boolean
  readonly notifications?: boolean
}

export interface HostScreen {
  readonly root: () => ReactNode
  readonly onDestroy?: () => void
}

export interface BootPaneHostOpts {
  readonly logContext?: string
  readonly providers?: HostProviderFlags
  readonly setup: (prefs: PersistedUiPrefs) => HostScreen | Promise<HostScreen>
}

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

const DETACHED_FPS = 2
const DETACH_CHECK_MS = 3000

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
      const applyPrefs = (payload: UiPrefsPayload | null) => {
        if (!payload) return
        applyUiPrefs(themeTarget, payload)
        if (isLocaleId(payload.locale)) setLocaleLang(payload.locale)
      }
      const prefsStore = remote.uiPrefsStore()
      applyPrefs(prefsStore.get())
      disposers.push(prefsStore.subscribe(() => applyPrefs(prefsStore.get())))

      const revStore = remote.keybindingsRevStore()
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

export async function bootPaneHost(opts: BootPaneHostOpts): Promise<void> {
  if (opts.logContext) setClientLogContext(opts.logContext)
  installClientCrashHandlers()
  applyUserKeybindings()
  for (const { name, theme } of loadUserThemes()) addTheme(name, theme)

  const prefs = readPersistedUiPrefs(FALLBACK_THEME)
  applyUiPrefs(themeTarget, {
    theme: prefs.theme,
    transparentBackground: prefs.transparent,
    focusAccent: prefs.focusAccent,
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
      <DetachFpsThrottle />
      <PaneErrorBoundary>{screen.root()}</PaneErrorBoundary>
    </>
  )
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
}
