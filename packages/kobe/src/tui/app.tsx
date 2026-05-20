/**
 * kobe TUI fallback shell.
 *
 * tmux owns the full multi-pane layout now (see `src/tmux/bootstrap.ts`
 * and the `kobe pane <name>` subprocesses). This file is the page kobe
 * renders ONLY when tmux mode is disabled — `$TMUX` already set,
 * `KOBE_TMUX=0`, stdin non-TTY, or tmux missing. The visible UI is a
 * single informational card telling the user how to enable tmux mode;
 * the orchestrator + daemon-disconnect dialog still mount so a stranded
 * fallback session can clean up gracefully.
 *
 * Pre-sprint-7 this file held the in-process 5-pane layout (sidebar /
 * chat / files / preview / terminal) and ~30 hooks worth of focus,
 * resize, keybinding, and completion-notification machinery. All of
 * that lives in the tmux pane subprocesses now.
 */

import { homedir } from "node:os"
import { render, useRenderer } from "@opentui/solid"
import { createEffect } from "solid-js"
import {
  connectOrStartDaemon,
  connectOrStartOwnedDaemon,
  ensureOwnedDaemonReachable,
} from "../client/daemon-process.ts"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { type TuiDaemonMode, resolveDaemonMode } from "../daemon/mode.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { NullMetadataSuggester } from "../orchestrator/metadata-suggester.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import { getSavedRepos, normalizeSavedRepos } from "../state/repos.ts"
import { PaneHeader } from "./component/pane-header"
import { CommandPaletteProvider } from "./context/command-palette"
import { FocusProvider } from "./context/focus"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider } from "./context/kv"
import { NotificationsProvider } from "./context/notifications"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, addTheme, useTheme } from "./context/theme"
import { loadUserThemes } from "./context/theme/loader"
import { buildEngines } from "./engine-bootstrap"
import { useBindings } from "./lib/keymap"
import { DialogConfirm } from "./ui/dialog-confirm"
import { DialogProvider, useDialog } from "./ui/dialog"

const DEFAULT_THEME = "claude"

export type AppDeps = {
  orchestrator: KobeOrchestrator
  onQuit?: () => Promise<void>
}

function FallbackPage(props: AppDeps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const renderer = useRenderer()

  let quitting = false
  const quit = () => {
    if (quitting) return
    quitting = true
    try {
      renderer?.destroy()
    } catch (err) {
      console.error("kobe: renderer.destroy() failed during quit:", err)
    }
    const forceExit = setTimeout(() => process.exit(0), 1500)
    forceExit.unref()
    void (props.onQuit?.() ?? Promise.resolve()).finally(() => {
      clearTimeout(forceExit)
      process.exit(0)
    })
  }

  // When the daemon socket drops, RemoteOrchestrator flips
  // `connectionState` to `"disconnected"`. Pop a modal so the user can
  // restart or quit instead of being stuck on a dead session. Mirrors
  // the pre-sprint-7 behavior; in-process Orchestrator stays "online"
  // forever so this effect is a no-op there.
  let showingDisconnectDialog = false
  async function showDisconnectDialog(): Promise<void> {
    const orch = props.orchestrator
    if (!(orch instanceof RemoteOrchestrator)) return
    let message = "The kobe daemon is no longer reachable. Restart it and reconnect, or quit kobe?"
    while (true) {
      const choice = await DialogConfirm.show(dialog, "daemon disconnected", message, "Quit", "Restart")
      if (choice !== true) {
        quit()
      }
      try {
        await orch.manualReconnect()
        return
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        message = `Restart failed: ${errMsg}\n\nTry again or quit?`
      }
    }
  }
  createEffect(() => {
    const orch = props.orchestrator
    if (!(orch instanceof RemoteOrchestrator)) return
    if (orch.connectionStateSignal()() !== "disconnected") return
    if (showingDisconnectDialog) return
    showingDisconnectDialog = true
    void showDisconnectDialog().finally(() => {
      showingDisconnectDialog = false
    })
  })

  // Global keybindings: ctrl+c twice quits (owned by useKobeKeybindings),
  // and a fallback-only single-key `q` confirm-quit chord. There is no
  // sidebar pane on this page, so the legacy sidebar-scoped `q` doesn't
  // apply — promote it to a global single-letter chord since the page
  // has no other interactive surfaces competing for the keystroke.
  useKobeKeybindings({
    onShowHelp: () => {},
    onQuit: quit,
  })
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "q",
        cmd: () => {
          DialogConfirm.show(dialog, "Quit kobe?", "Any in-progress tasks will be detached.", "stay").then((ok) => {
            if (ok === true) quit()
          })
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" padding={2}>
      <box flexDirection="column" width={64} backgroundColor={theme.backgroundPanel} padding={2}>
        <PaneHeader title="KOBE — TMUX MODE REQUIRED" focused />
        <box paddingTop={1} paddingLeft={2} paddingRight={2} flexDirection="column" gap={1}>
          <text fg={theme.text} wrapMode="word">
            kobe now runs inside a tmux session that owns the chat pane plus
            the sidebar / tab-strip / files / status subprocesses. This
            fallback page renders when tmux mode is disabled or unavailable.
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            To enable tmux mode: install tmux on PATH, unset $TMUX (so kobe
            can start its own server), and re-run kobe. To force-enable from
            a parent tmux, set KOBE_TMUX=1.
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            Press q to quit, or ctrl+c twice.
          </text>
        </box>
      </box>
    </box>
  )
}

function App(props: AppDeps) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <KVProvider>
        <NotificationsProvider>
          <SyncProvider>
            <DialogProvider>
              <CommandPaletteProvider>
                <FocusProvider>
                  <FallbackPage {...props} />
                </FocusProvider>
              </CommandPaletteProvider>
            </DialogProvider>
          </SyncProvider>
        </NotificationsProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

/**
 * Mount the fallback app. Builds the orchestrator stack (same as the
 * pre-sprint-7 startApp), then renders `<App />`. The orchestrator
 * bootstrap stays even on the fallback page so the daemon stays
 * healthy and the disconnect dialog can fire.
 */
export async function startApp(options: { daemonMode?: TuiDaemonMode } = {}): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  let orchestrator: KobeOrchestrator
  let stopOwnedDaemon: (() => Promise<void>) | undefined
  let ownedDaemonStopped = false
  const stopOwnedDaemonOnce = async (): Promise<void> => {
    if (ownedDaemonStopped) return
    ownedDaemonStopped = true
    await stopOwnedDaemon?.()
  }
  if (process.env.KOBE_TEST_ENGINE || process.env.KOBE_NO_DAEMON === "1") {
    const engines = await buildEngines()
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const worktrees = new GitWorktreeManager()
    orchestrator = new Orchestrator({
      engines,
      store,
      worktrees,
      ...(process.env.KOBE_TEST_ENGINE ? { metadataSuggester: new NullMetadataSuggester() } : {}),
    })
    try {
      const { startBridge } = await import("../orchestrator/bridge/index.ts")
      await startBridge(orchestrator, { homeDir })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] bridge failed to start:", err)
    }
  } else {
    const daemonMode = resolveDaemonMode(options.daemonMode)
    if (daemonMode === "shared") {
      orchestrator = new RemoteOrchestrator(await connectOrStartDaemon())
    } else {
      const owned = await connectOrStartOwnedDaemon()
      stopOwnedDaemon = owned.stop
      orchestrator = new RemoteOrchestrator(owned.client, {
        ensureReachable: () => ensureOwnedDaemonReachable(owned.socketPath, owned.pidPath),
      })
    }
    await orchestrator.init()
  }
  normalizeSavedRepos()
  for (const repo of getSavedRepos()) {
    try {
      await orchestrator.ensureMainTask(repo)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[kobe] ensureMainTask failed for ${repo}:`, err)
    }
  }
  await render(() => <App orchestrator={orchestrator} onQuit={stopOwnedDaemonOnce} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    onDestroy: () => {
      void stopOwnedDaemonOnce().catch(() => {})
    },
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  })
}
