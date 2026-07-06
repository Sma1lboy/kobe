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

const FALLBACK_THEME = "claude"

export interface HostProviderFlags {
  readonly kv?: boolean
  readonly focus?: boolean
  readonly notifications?: boolean
}

export interface HostScreen {
  readonly root: () => JSX.Element
  readonly onDestroy?: () => void
}

export interface BootPaneHostOpts {
  readonly logContext?: string
  readonly providers?: HostProviderFlags
  readonly setup: (prefs: PersistedUiPrefs) => HostScreen | Promise<HostScreen>
}

function applyHostBootSteps(logContext?: string): void {
  if (logContext) setClientLogContext(logContext)
  installClientCrashHandlers()
  applyUserKeybindings()
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
}

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

function PaneCrashFallback(props: { error: unknown }) {
  const { theme } = useTheme()
  onMount(() => logClientError("pane-crash", props.error))
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} paddingLeft={1} paddingTop={1} gap={1}>
      <text fg={theme.error}>{t("common.paneCrash.title")}</text>
      <text fg={theme.textMuted}>{t("common.paneCrash.hint")}</text>
    </box>
  )
}

const DETACHED_FPS = 2
const DETACH_CHECK_MS = 3000

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
  }

  applyUiPrefs(target, {
    theme: props.boot.theme,
    transparentBackground: props.boot.transparent,
    focusAccent: props.boot.focusAccent,
  })
  setLocaleLang(props.boot.locale)

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
    if (isLocaleId(payload.locale)) setLocaleLang(payload.locale)
  })

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
