/**
 * Centralised keymap registration for the app shell.
 *
 * Before this module existed, `src/tui/app.tsx` had six separate
 * `useBindings(...)` call sites scattered through the Shell function.
 * Priority was implicit-by-mount-order: whichever block was
 * physically further down in the file got registered later and
 * therefore won when chords collided. Hard to find, hard to reason
 * about, hard to move a binding without re-reading the entire file.
 *
 * `useAppKeymap` takes a single `deps` bag and registers every
 * top-level binding in a deterministic, scope-grouped order:
 *
 *   1. SHELL_NUMERIC      — ctrl+1..4 pane focus, ctrl+= / ctrl+- resize.
 *                           Gated only on "no dialog open".
 *   2. WORKSPACE_SCOPED   — ctrl+q (workspace → sidebar). Gated on the
 *                           workspace being focused.
 *   3. SIDEBAR_SCOPED     — n / q / s plain-letter chords. Gated on the
 *                           sidebar being focused; plain letters MUST
 *                           be pane-scoped per docs/KEYBINDINGS.md.
 *   4. GLOBAL_MODIFIER    — ctrl+, settings. Modifier-prefixed → safe
 *                           to leave global.
 *   5. TEST_PR_HOTKEY     — ctrl+y, gated on KOBE_TEST_PR_HOTKEY=1.
 *                           Production never enables this.
 *
 * If a future binding collides between two scopes, the registration
 * order above is the resolution rule — and the comment block at the
 * top of each section explains why that scope owns the chord.
 *
 * Per docs/KEYBINDINGS.md: plain letters MUST be pane-scoped; globals
 * MUST be modifier-prefixed. This file enforces that grammar in one
 * place rather than spread across six call sites.
 */

import type { Accessor } from "solid-js"
import type { KobeOrchestrator } from "../client/remote-orchestrator.ts"
import type { Task } from "../types/task.ts"
import { type PaneId } from "./context/focus"
import { bindByIds } from "./context/keybindings"
import type { KVContext } from "./context/kv"
import { useBindings } from "./lib/keymap"
import { SettingsDialog } from "./component/settings-dialog"
import { DialogConfirm } from "./ui/dialog-confirm"
import type { DialogContext } from "./ui/dialog"

/* --------------------------------------------------------------------- */
/*  Shape of dependencies                                                  */
/* --------------------------------------------------------------------- */

/**
 * Renderer handle from `@opentui/solid`. Imported as a structural
 * type so this module doesn't pull opentui at type-load time (matches
 * the rest of the file's lightweight-imports policy).
 */
type RendererHandle = { destroy: () => void }

/**
 * The Shell-owned state the keymap needs to read or update. Passed
 * in fresh from `app.tsx`; nothing here owns state of its own.
 */
export type AppKeymapDeps = {
  /** Dialog stack — every binding is gated on `stack.length === 0`. */
  dialog: DialogContext
  /** Focus accessors + setter. */
  focusedPane: Accessor<PaneId>
  setFocusedPane: (id: PaneId) => void
  /** Per-pane resize nudge — direction comes from the keybinding. */
  nudgeFocusedPane: (delta: number) => void
  /** Resize step (cells) — kept in one place for symmetry with grow/shrink. */
  resizeStep: number
  /** Maps focus.numeric event names to pane targets (h/j/k/l). */
  focusHjklTargets: Record<string, PaneId>
  /** Open the new-task dialog flow (defined in app.tsx — uses kv, orchestrator, etc.). */
  openNewTaskFlow: () => Promise<void> | void
  /** KV store + orchestrator handle for the settings dialog. */
  kv: KVContext
  orchestrator: KobeOrchestrator
  /** Renderer handle for the quit path — undefined under tests that don't mount opentui. */
  renderer: RendererHandle | undefined
  /** Active task accessor — needed by the test-only ctrl+y PR hotkey. */
  activeTask: Accessor<Task | undefined>
}

/* --------------------------------------------------------------------- */
/*  Registration                                                           */
/* --------------------------------------------------------------------- */

/**
 * Register every top-level app keybinding in one call. Priority is
 * the source order below — earlier `useBindings(...)` calls win
 * later (later-mounted wins; see `_bindingStackSize` semantics in
 * `lib/keymap.tsx`).
 *
 * Must be called inside a Solid component scope so the underlying
 * `useBindings` hook can register / cleanup correctly. Typical
 * call-site: `Shell()` in `app.tsx`, after focus + dialog deps are
 * available.
 */
export function useAppKeymap(deps: AppKeymapDeps): void {
  const { dialog, focusedPane } = deps

  /* ----- 1. Shell-wide numeric pane focus + resize ----- */
  // ctrl+hjkl pane focus. h/j/k/l → sidebar / workspace / files /
  // terminal (ordinal 1/2/3/4 mapped onto the vim row). ctrl+letter
  // chords have stable C0 control byte mappings, so they work in
  // every terminal + tmux config without CSI-u / kitty keyboard /
  // per-user setup. The handler reads `evt.name` to dispatch.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: bindByIds({
      "focus.numeric": (evt) => {
        const target = deps.focusHjklTargets[evt.name ?? ""]
        if (target) deps.setFocusedPane(target)
      },
    }),
  }))

  // Keyboard resize for the focused pane — fallback when mouse drag
  // misfires on the splitter. ctrl+= / ctrl++ grows, ctrl+- / ctrl+_
  // shrinks. The keymap normalizer (lib/keymap.tsx) drops the shift
  // modifier on single-char names since shift+= already produces `+`,
  // so we register both `+` and `=` on the grow side and both `-` and
  // `_` on the shrink side to match whatever shape the terminal sends.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: bindByIds({
      "pane.resize-grow": () => deps.nudgeFocusedPane(deps.resizeStep),
      "pane.resize-shrink": () => deps.nudgeFocusedPane(-deps.resizeStep),
    }),
  }))

  /* ----- 2. Workspace-scoped ----- */
  // ctrl+q from the workspace (chat pane) jumps focus back to the
  // sidebar. Workspace-scoped — this is the "trapped in the chat
  // composer, want out" verb. Other panes use ctrl+1..4 / esc.
  useBindings(() => ({
    enabled: focusedPane() === "workspace" && dialog.stack.length === 0,
    bindings: bindByIds({
      "focus.sidebar": () => deps.setFocusedPane("sidebar"),
    }),
  }))

  /* ----- 3. Sidebar-scoped plain-letter chords ----- */
  // `n` (task.new), `q` (app.quit), `s` (settings) only fire when
  // the SIDEBAR is focused — single-letter chords would otherwise
  // collide with composer typing. Once on the sidebar, `n` opens
  // the new-task dialog, `q` opens quit-confirm, `s` opens settings.
  useBindings(() => ({
    enabled: focusedPane() === "sidebar" && dialog.stack.length === 0,
    bindings: bindByIds({
      "task.new": () => {
        void deps.openNewTaskFlow()
      },
      "settings.open.sidebar": () => {
        void SettingsDialog.show(dialog, deps.kv, deps.orchestrator)
      },
      "app.quit": () => {
        DialogConfirm.show(dialog, "Quit kobe?", "Any in-progress tasks will be detached.", "stay").then((ok) => {
          if (ok === true) {
            try {
              deps.renderer?.destroy()
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error("kobe: renderer.destroy() failed during quit:", err)
            }
            process.exit(0)
          }
        })
      },
    }),
  }))

  /* ----- 4. Global modifier-prefixed chords ----- */
  // `ctrl+,` (settings.open) is a modifier chord — safe to leave
  // global since it can't collide with typing.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: bindByIds({
      "settings.open": () => {
        void SettingsDialog.show(dialog, deps.kv, deps.orchestrator)
      },
    }),
  }))

  /* ----- 5. Test-only hidden hotkey ----- */
  // Test-only hidden hotkey affordance for the W4.PR behavior test.
  // Mouse-clicking the CreatePRButton from a PTY harness is awkward
  // (opentui's mouse-event delivery needs SGR capability negotiation
  // that the screen-capture path doesn't honor). When
  // KOBE_TEST_PR_HOTKEY=1 we register a hidden ctrl+y binding that
  // calls the same handler. We chose ctrl+y because (a) it's not in
  // opentui's defaultTextareaKeyBindings (so the composer won't
  // intercept it via preventDefault) and (b) kobe's keymap (see
  // src/tui/lib/keymap.tsx) drops the shift modifier on single-letter
  // keys, so chords like "ctrl+shift+p" never match anything emitted by
  // node-pty. A second test path is the fake-engine HTTP server's POST
  // /pr endpoint (see mountFakeEngineServer in app.tsx) which bypasses
  // the keymap entirely. Production never sets either env var.
  useBindings(() => ({
    enabled: process.env.KOBE_TEST_PR_HOTKEY === "1" && dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+y",
        cmd: () => {
          const task = deps.activeTask()
          if (!task || !task.worktreePath || task.status === "canceled") return
          deps.orchestrator.requestPR(task.id).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("[kobe] requestPR failed:", err)
          })
        },
      },
    ],
  }))
}
