/**
 * Server-scoped tmux bindings/hooks installer for a freshly-created kobe
 * session — split out of `tmux-session.ts` (which was itself over the
 * repo's 500-line file-size cap once `ensureSessionImpl` moved there) so
 * this half of the create path gets its own file. Same behavior, moved
 * verbatim: `installSessionBindings(inv)` is the exact tail of the old
 * `ensureSessionImpl` (status bar, hooks, key bindings, clipboard), called
 * once from `tmux-session-create.ts`'s `createSession`.
 *
 * Also houses the directional pane-focus keybinding helpers
 * (`focusBindCommand`/`tasksRestoreEdgeCommand`) only this bindings block
 * consumes.
 */

import { KOBE_TMUX_SOCKET, runTmuxSequence } from "@/tmux/client"
import { clipboardBinaryOnPath, clipboardTmuxConfig, resolveClipboardCopyCommand } from "@/tmux/clipboard"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_LEGACY_LAYOUT_ROOT_KEYS,
  TMUX_SINGLE_BINDING_DEFAULTS,
  chordToTmuxKey,
  isTmuxPrefixBindingId,
  resolveUserTmuxKeys,
} from "@/tmux/keybindings"
import { HIDDEN_TASKS_PANE_OPTION, openUrlCommand, shellQuote } from "@/tmux/session-layout"
import {
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  kobeStatusRight,
} from "./chattab"
import { inheritedEnvPrefix } from "./launch"

/** Direction flag → the tmux format var that is `1` when the pane sits at that edge. */
const FOCUS_EDGE_VARS = {
  "-L": "pane_at_left",
  "-D": "pane_at_bottom",
  "-U": "pane_at_top",
  "-R": "pane_at_right",
} as const

export type FocusDirection = keyof typeof FOCUS_EDGE_VARS

/**
 * One directional pane-focus binding, edge-guarded so it never WRAPS.
 *
 * Bare `select-pane -L` wraps at the window edge — ctrl+h from the
 * leftmost Tasks pane landed on the RIGHTMOST pane, which reads as a
 * teleport, not a move. The guard makes an edge press a no-op instead:
 * `if-shell -F "#{?pane_at_left,,1}" "select-pane -L"` expands the
 * conditional to `""` at the edge (falsy → if-shell runs nothing; the
 * else command is simply OMITTED, which parses fine) and `"1"` elsewhere
 * (truthy → the move runs). Verified live on tmux 3.5a (scratch `-L`
 * socket): a real attached client's ctrl+h was a no-op on the leftmost
 * pane and still moved left from a middle pane; same for the
 * top/bottom/right edge vars. Wraps whatever key the user resolved for
 * the `tmux.focus` group — the guard lives on the command side.
 *
 * ZOOM exemption: a zoomed pane reports ALL FOUR `pane_at_*` flags as 1
 * (verified live), so a bare edge guard would turn every focus chord
 * into a dead key while zoomed. The outer `window_zoomed_flag`
 * conditional bypasses the guard when zoomed, so the chord falls
 * through to plain `select-pane` — which unzooms and moves, exactly the
 * pre-guard behavior (also verified live: zoomed %1 + ctrl+h → %0,
 * zoom released).
 */
export function focusBindCommand(key: string, dir: FocusDirection, edgeCommand?: string): readonly string[] {
  const condition = `#{?window_zoomed_flag,1,#{?${FOCUS_EDGE_VARS[dir]},,1}}`
  if (edgeCommand) {
    return ["bind-key", "-n", key, "if-shell", "-F", condition, `select-pane ${dir}`, edgeCommand]
  }
  return ["bind-key", "-n", key, "if-shell", "-F", condition, `select-pane ${dir}`]
}

/**
 * The ctrl+h left-edge fallback: restore/focus the Tasks rail via the
 * kobe CLI. Two guards, both load-bearing (the "kobe freezes for a few
 * seconds / ctrl+hjkl feels random" macOS Terminal report):
 *
 * - `run-shell -b`: a FOREGROUND run-shell stalls tmux's entire command
 *   queue until the spawned process exits (man tmux, COMMAND PARSING AND
 *   EXECUTION), so every left-edge press blocked the client for a full
 *   CLI startup and rapid presses queued serially into multi-second
 *   freezes; a failing spawn additionally dropped the pane into view
 *   mode, eating keystrokes until dismissed.
 * - the `@kobe_role` gate skips the spawn entirely for the hot case —
 *   pressing ctrl+h while already sitting in the leftmost Tasks pane
 *   (vim muscle-memory spam), where the restore only re-selected the
 *   pane the user was already in. The rail-hidden and rail-crashed
 *   cases still fire: their left-edge pane is the engine/shell, whose
 *   role is never `tasks`.
 *
 * The nested run-shell is wrapped in tmux BRACES, not double quotes:
 * the shell-quoted CLI command contains `'\''` sequences (env prefix +
 * `--session '#{session_name}'`), and tmux double-quote parsing
 * processes those backslashes — the re-parse then splits the command
 * ("run-shell: too many arguments"). Braces copy the content verbatim,
 * so the branch re-parses exactly like the pre-gate argv form did.
 * Both branches verified live on tmux 3.6 via `run-shell -C`
 * re-parsing with a production-shaped command (fires with no/other
 * role, no-op with `@kobe_role=tasks`).
 */
export function tasksRestoreEdgeCommand(restoreTasksCommand: string): string {
  return `if-shell -F '#{?#{==:#{@kobe_role},tasks},,1}' { run-shell -b ${shellQuote(restoreTasksCommand)} }`
}

/**
 * Server-scoped niceties — done after the session is alive so the
 * server is definitely up. All `-g` options are idempotent so
 * calling them on every ensureSession is harmless.
 *
 * Status bar: ON (KOB-233). v0.5/KOB-225 hid it because there was
 * only one pane and it was pure noise. With three panes it's useful
 * — it tells the user they're inside a kobe-managed tmux session,
 * which pane/window is active, and how to get out. We explicitly
 * set `on` (not just "leave default") so a server that an older
 * kobe turned OFF flips back.
 *
 * The status/window bar content is set here; its theme is applied by the
 * caller's `applyTmuxChromeTheme()` afterward. The `-L kobe` socket still
 * loads the user's `~/.tmux.conf`, but kobe owns visual chrome on its own
 * isolated socket so the bottom ChatTab switcher matches the active kobe
 * theme. The session name (`kobe-<task-id>`, shown via the user's default
 * `#S` in status-left) remains the only identity we impose on the left.
 *
 * status-right is set minimally: from inside the engine/shell
 * pane the user otherwise has zero on-screen hint for kobe's
 * escape-hatch chords (get back to Tasks, detach, new tab). We show
 * the most useful ones; `status-right-style` supplies the themed muted
 * foreground. Server-scoped on
 * the isolated `-L kobe` socket, so the user's real tmux status-right
 * is never touched.
 * Window-status format: a compact activity icon in each ChatTab label.
 * `monitor-activity` is tmux-native and means "this window produced
 * output since you last viewed it", which is the reliable signal we have
 * inside a pure tmux handover without scraping engine-specific prompts.
 * Mouse: ON. The Tasks pane's click-to-switch and the Ops FileTree's
 * click/scroll only work if tmux forwards mouse events to the pane's
 * app. Most configs already set this, but we force it on the `-L
 * kobe` socket so the feature doesn't depend on the user's config.
 * No-prefix Ctrl+Q is two-stage while the Tasks pane is visible: focus the
 * current window's Tasks pane, then detach back to the launching shell on a
 * second press from there. If Tasks is hidden, Ctrl+Q detaches directly since
 * there is no rail stage to land on.
 * No-prefix Ctrl+h/j/k/l move between panes directionally — the
 * vim-tmux-navigator convention — and are edge-guarded so they never
 * wrap (see focusBindCommand). (Ctrl+1/2/3 was tried first but
 * terminals can't encode Ctrl+<digit> without the kitty protocol, so
 * the bindings registered yet never fired — KOB-233.) Directional
 * keys DO produce distinct codes and are the tmux-idiomatic choice.
 * Server-scoped on the `-L kobe` socket so the user's own tmux is
 * untouched. Trade-off: this shadows readline Ctrl+k (kill-line) /
 * Ctrl+l (clear) inside the claude + shell panes; acceptable for the
 * pane-nav win, and the prefix (Ctrl+B arrows) still works too.
 * Ctrl+T opens a same-engine chat tab = a new window with its own
 * engine process (fresh conversation) + the same panes, on the same
 * worktree. Ctrl+Shift+T (when the terminal forwards it) and prefix T
 * prompt for a specific engine before creating the tab.
 * No-prefix Ctrl+[ / Ctrl+] mirror kobe's old self-rendered chat-tab
 * cycle, but now map directly to tmux windows inside the handover.
 * Ctrl+W restores the v0.5 close-tab affordance. It deliberately
 * refuses to close the final window: tmux treats that as killing the
 * whole task session, while the user intent here is "close this
 * ChatTab", not "destroy the Task handover". F2 restores the v0.5
 * rename-tab affordance as a native tmux window rename.
 * `kobe new-chattab` reads the session's @kobe_task / @kobe_worktree
 * tags so the binding only needs to pass the session name (which
 * tmux expands at fire time).
 * Bake kobe's env onto the run-shell chords too (same reason as the
 * pane commands — see inheritedEnvPrefix), so `new-chattab` /
 * `quick-create` spawn against the SAME home + daemon as this monitor.
 */
export async function installSessionBindings(inv: readonly string[]): Promise<void> {
  const envStr = inheritedEnvPrefix()
  const invStr = inv.map(shellQuote).join(" ")
  const newChatTabCommand = `${envStr}${invStr} new-chattab --session '#{session_name}'`
  const chooseEngineCommand = `${newChatTabCommand} --vendor '%%'`
  const chooseEngineTmuxCommand = `run-shell ${shellQuote(chooseEngineCommand)}`
  // Two-stage Ctrl+Q: `kobe focus-tasks` selects/restores the current window's
  // Tasks pane (the else branch of the if-shell below). The detach branch is
  // reached when focus is already on Tasks, or immediately when Tasks is hidden.
  const focusTasksCommand = `${envStr}${invStr} focus-tasks --session '#{session_name}' --window '#{window_id}'`
  const focusTasksTmuxCommand = `run-shell ${shellQuote(focusTasksCommand)}`
  const layoutCommand = (action: string): string =>
    `${envStr}${invStr} layout --session '#{session_name}' --window '#{window_id}' --action ${action}`
  const restoreTasksCommand = layoutCommand("tasks-restore")

  const closeChatTabCommand = layoutCommand("chat-tab-close")
  const closeChatTabTmuxCommand = `run-shell ${shellQuote(closeChatTabCommand)}`
  // Re-pin the layout whenever a window settles to a new size. The FIRST task
  // session is built before any client is attached, so tmux sizes its window to
  // a stale default and reflows every pane PROPORTIONALLY once `attach` lands
  // the real terminal size — blowing up the absolute-width Tasks rail. The reuse
  // path heals later switches, but the first attach had none, so the very first
  // view was off until the user switched once.
  //
  // The hook is `window-resized`, NOT `client-attached`: on attach with a size
  // change tmux fires `client-attached` BEFORE it resizes the window (so a heal
  // there runs against the OLD size and is immediately undone by the resize),
  // then `window-resized` AFTER the new size lands. Healing on `window-resized`
  // re-pins against the SETTLED size — and also covers a live terminal resize,
  // which reflows the rail the same way. `-b` runs it in the background so tmux
  // isn't blocked; `resize-pane` never changes the window size, so the heal
  // can't re-trigger the hook. Reused below for the `pane-exited` hook — a pane close reflows the rail the
  // same way a resize does, and the same re-pin recovers it.
  const healLayoutCommand = `${envStr}${invStr} heal-layout --session '#{session_name}'`
  const healLayoutTmuxCommand = `run-shell -b ${shellQuote(healLayoutCommand)}`
  // `client-resized` companion to the `window-resized` heal. The pre-attach /
  // pre-switch `resize-window` flips the window to `manual` sizing, so a LIVE
  // terminal GROW no longer auto-resizes the window and `window-resized` never
  // fires for it — the UI stays letterboxed small until a task switch or reopen.
  // `client-resized` fires on every terminal size change regardless of the pin,
  // so we re-pin the window to the new client size (outer frame follows the
  // terminal) and heal the rail. Client dims are passed as ARGS: the detached
  // `-b` shell isn't attached to a client, so it can't read its own
  // `#{client_*}`. `resync-window` coalesces the drag's burst to one re-pin.
  const resyncWindowCommand = `${envStr}${invStr} resync-window --session '#{session_name}' --client '#{client_name}' --cols '#{client_width}' --rows '#{client_height}' --status '#{status}'`
  const resyncWindowTmuxCommand = `run-shell -b ${shellQuote(resyncWindowCommand)}`
  // Capture a manual rail / right-column drag the moment it happens, on
  // `window-layout-changed` (which fires on a pane resize, unlike
  // `window-resized`). Without this, a drag was only persisted into the global
  // on switch-away, so dragging the rail and THEN resizing the terminal lost
  // the drag — the resize's `window-resized` heal re-pinned every pane to the
  // STALE global before the drag was ever captured. `capture-layout` is gated
  // (resize-recency + not-zoomed + full role set) so it captures only genuine
  // drags, never a resize reflow or a half-built layout. Both hooks coalesce
  // their event bursts to one run (see layout-coord.ts).
  const captureLayoutCommand = `${envStr}${invStr} capture-layout --session '#{session_name}'`
  const captureLayoutTmuxCommand = `run-shell -b ${shellQuote(captureLayoutCommand)}`
  // `<prefix> u` = open a URL from the focused pane. iTerm2's Cmd+click reads the
  // RENDERED grid, so a URL that wraps at the (narrower-than-terminal) tmux pane
  // boundary is captured half-truncated. `capture-pane -J` joins the visual wrap
  // back into the full logical line, so the URL survives intact. `#{pane_id}`
  // expands at fire time → the pane that was focused, before the popup steals
  // active. fzf when present (filter/pick); else open the most-recent match.
  // BSD `xargs -I{}` runs nothing on empty input (no stray Finder on cancel/no-match).
  const openUrlTmuxCommand = openUrlCommand({ tmuxSocket: KOBE_TMUX_SOCKET })
  // Pane-aware drag-copy to the SYSTEM clipboard. `mouse on` (below) already
  // routes a plain left-drag into copy-mode, which selects WITHIN the focused
  // pane — the pane-aware behaviour we want. But tmux's default leaves that
  // selection only in its own paste buffer, so users fall back to the
  // terminal's native Option+drag, which bleeds the selection ACROSS panes.
  // `set-clipboard on` lets tmux push the selection to the terminal's
  // clipboard via OSC 52; when a local clipboard tool is present we ALSO pipe
  // the copy-mode "finish selection" actions straight to it (pbcopy / wl-copy
  // / xclip / xsel), covering the drag-release (`MouseDragEnd1Pane` — the exact
  // user flow) and keyboard copy (`y` / Enter), in BOTH the emacs and vi
  // copy-mode tables. A missing tool is graceful: we keep `set-clipboard on`
  // (OSC 52 only) and skip the copy-pipe bindings, never breaking session
  // creation. These are copy-mode-table bindings only, so a pane app that
  // grabs mouse events (its own selection) is unaffected.
  const clipboardCopyCommand = resolveClipboardCopyCommand(process.platform, clipboardBinaryOnPath)
  const clipboardBindings = clipboardTmuxConfig(clipboardCopyCommand)
  // `<prefix> f` = quick-create: open the prompt-only quick-task page (the
  // v0.5 quick-fork chord, KOB-74, reborn in the tmux world). `kobe
  // quick-create` opens `kobe quick-task` in its own window, which asks for
  // ONLY a prompt and fills repo / engine / base branch from this task's
  // defaults, then creates + delivers and exits. PREFIX-scoped (not no-prefix
  // C-f): a no-prefix Ctrl+F was unusable — it shadows readline
  // forward-char in the claude/shell panes and several apps grab it, so
  // the chord never reliably reached tmux. `<prefix> f` ("fork") is a
  // two-key chord but conflict-free; the prefix is whatever the user's
  // own tmux.conf sets (we load it on the `-L kobe` socket).
  // Multi-client sizing: a task session can have >1 client attached (two
  // `kobe` processes on the same task, or a detached big terminal + a fresh
  // small one). tmux's default sizes a window to the SMALLEST client of the
  // session regardless of which window that client is actually viewing — so a
  // small client on chat-tab B drags chat-tab A down for the big client too,
  // which then squeezes the fixed-width Tasks pane (KOB-248) against a too-narrow
  // window. `aggressive-resize on` scopes the size to the client(s) for which the
  // window is CURRENT, so each chat-tab window tracks only its own viewer.
  // Same-session clients still share one tmux grid; prepareWindowForAttach /
  // prepareWindowForSwitch mitigate that by marking already-attached clients
  // with conflicting terminal sizes as `ignore-size`, so passive monitors do not
  // letterbox the screen being actively entered. True independent same-window
  // sizes still require per-client sessions (a larger refactor, deferred).
  // Session keys come from the user-resolvable tmux key set (defaults
  // C-q / C-hjkl / C-t / C-S-T / C-[ / C-] / C-w / F2 plus prefix-scoped
  // layout keys; overridable via `~/.kobe/settings/keybindings.yaml`,
  // `tmux.*` ids). For every
  // OVERRIDDEN id we first unbind its DEFAULT key: the tmux server is
  // long-lived, so a previous run (or an older kobe) may have bound it —
  // without the unbind both the old and new chord would fire. We also always
  // unbind the short-lived F6-F11 layout defaults from 0.7.30 so an upgraded,
  // long-lived tmux server drops those root-table conflicts. Unbinding a
  // never-bound root/prefix key exits 0 silently, so this is safe on a fresh
  // server too. An id resolved to null installs nothing (user unbind).
  const userKeys = resolveUserTmuxKeys()
  const unbinds: (readonly string[])[] = TMUX_LEGACY_LAYOUT_ROOT_KEYS.map((key) => ["unbind-key", "-n", key])
  if (userKeys.overridden.has(TMUX_FOCUS_ID)) {
    for (const chord of TMUX_FOCUS_DEFAULTS) {
      const t = chordToTmuxKey(chord)
      if ("key" in t) unbinds.push(["unbind-key", "-n", t.key])
    }
  }
  for (const id of userKeys.overridden) {
    if (id === TMUX_FOCUS_ID) continue
    const def = TMUX_SINGLE_BINDING_DEFAULTS[id as keyof typeof TMUX_SINGLE_BINDING_DEFAULTS]
    const isPrefix = isTmuxPrefixBindingId(id)
    const t = chordToTmuxKey(def, { allowBare: isPrefix })
    if ("key" in t) unbinds.push(isPrefix ? ["unbind-key", t.key] : ["unbind-key", "-n", t.key])
  }
  const focusDirections: readonly FocusDirection[] = ["-L", "-D", "-U", "-R"]
  const focusBinds = userKeys.focus.flatMap((bind, i) => {
    const dir = focusDirections[i]
    const edgeCommand = dir === "-L" ? tasksRestoreEdgeCommand(restoreTasksCommand) : undefined
    return bind && dir ? [focusBindCommand(bind.key, dir, edgeCommand)] : []
  })
  const b = userKeys.binds
  const layoutBind = (id: keyof typeof b, action: string): (readonly string[])[] => {
    const bind = b[id]
    return bind ? ([["bind-key", bind.key, "run-shell", layoutCommand(action)]] as const) : []
  }
  const layoutChordGroup = (...ids: (keyof typeof b)[]): string | null => {
    const chords = ids.map((id) => b[id]?.chord).filter((chord): chord is string => !!chord)
    return chords.length > 0 ? chords.join("/") : null
  }
  // Same surface guard chatTabSwitchBindings uses (kept identical): "0" (skip) on
  // a surface window, "1" (switch) everywhere else. Reused by the single-direction
  // tab-switch fallbacks below so a lone prev/next chord doesn't fire raw on a
  // half-filled surface dialog.
  const TAB_SWITCH_SURFACE_GUARD = "#{?#{@kobe_surface},0,1}"
  await runTmuxSequence([
    ["set-option", "-g", "status", "on"],
    ["set-window-option", "-g", "aggressive-resize", "on"],
    ["set-option", "-g", "monitor-activity", "on"],
    ["set-option", "-g", "visual-activity", "off"],
    ["set-option", "-g", "window-status-format", CHAT_TAB_STATUS_FORMAT],
    ["set-option", "-g", "window-status-current-format", CHAT_TAB_STATUS_CURRENT_FORMAT],
    [
      "set-option",
      "-g",
      "status-right",
      kobeStatusRight({
        focusLeft: userKeys.focus[0]?.key ?? null,
        detach: b["tmux.detach"]?.key ?? null,
        newTab: b["tmux.tab.new"]?.key ?? null,
        layoutSplits: layoutChordGroup(
          "tmux.layout.workspaceSplit",
          "tmux.layout.workspaceClose",
          "tmux.layout.workspaceReset",
        ),
        layoutPanes: layoutChordGroup(
          "tmux.layout.tasksToggle",
          "tmux.layout.opsToggle",
          "tmux.layout.terminalToggle",
          "tmux.layout.zenToggle",
        ),
      }),
    ],
    ["set-option", "-g", "mouse", "on"],
    // Let a pane-aware copy-mode selection reach the system clipboard:
    // `set-clipboard on` (OSC 52 fallback, always) + copy-pipe bindings when a
    // local clipboard tool is available. See the comment on clipboardBindings.
    ...clipboardBindings,
    ["set-hook", "-g", "window-resized", healLayoutTmuxCommand],
    ["set-hook", "-g", "client-resized", resyncWindowTmuxCommand],
    // Re-pin the layout when a pane CLOSES too. Exiting a kobe-owned shell pane
    // (the user types `exit` in a workspace-split terminal) destroys it and tmux
    // gives its cells to a neighbour, reflowing the absolute-width Tasks rail and
    // the right column off their pinned geometry — the same disorder a resize
    // causes, but `window-resized` never fires (the window size is unchanged), so
    // the only existing recovery was switching tasks (which heals on switch-in).
    // The currently-focused task therefore stayed broken until a manual re-drag.
    // `pane-exited` (tmux ≥ 2.2) fires on that close; `heal-layout` re-pins to the
    // shared globals — the SAME idempotent, coalesced heal a switch runs. No-op
    // for role-less sessions and for panes already at the target geometry.
    ["set-hook", "-g", "pane-exited", healLayoutTmuxCommand],
    ["set-hook", "-g", "window-layout-changed", captureLayoutTmuxCommand],
    ...unbinds,
    // Two-stage: on the Tasks pane → detach (the old exit); anywhere else →
    // focus the current window's Tasks pane first. `#{@kobe_role}` is the
    // active pane's role tag.
    ...(b["tmux.detach"]
      ? [
          [
            "bind-key",
            "-n",
            b["tmux.detach"].key,
            "if-shell",
            "-F",
            `#{?#{${HIDDEN_TASKS_PANE_OPTION}},1,#{==:#{@kobe_role},tasks}}`,
            "detach-client",
            focusTasksTmuxCommand,
          ] as const,
        ]
      : []),
    ...focusBinds,
    ...(b["tmux.tab.new"] ? [["bind-key", "-n", b["tmux.tab.new"].key, "run-shell", newChatTabCommand] as const] : []),
    ...(b["tmux.tab.chooseEngine"]
      ? chatTabChooseEngineBindings(b["tmux.tab.chooseEngine"].key).map(
          (binding) => [...binding, chooseEngineTmuxCommand] as const,
        )
      : []),
    ...(b["tmux.tab.prev"] && b["tmux.tab.next"]
      ? chatTabSwitchBindings(b["tmux.tab.prev"].key, b["tmux.tab.next"].key)
      : b["tmux.tab.prev"]
        ? // Single-direction fallback must carry the SAME surface guard as
          // chatTabSwitchBindings — a lone prev/next chord fires from the
          // session-global root table too, so raw `previous-window`/`next-window`
          // would yank the user off a half-filled surface dialog.
          [
            [
              "bind-key",
              "-n",
              b["tmux.tab.prev"].key,
              "if-shell",
              "-F",
              TAB_SWITCH_SURFACE_GUARD,
              "previous-window",
            ] as const,
          ]
        : b["tmux.tab.next"]
          ? [
              [
                "bind-key",
                "-n",
                b["tmux.tab.next"].key,
                "if-shell",
                "-F",
                TAB_SWITCH_SURFACE_GUARD,
                "next-window",
              ] as const,
            ]
          : []),
    ...(b["tmux.tab.close"] ? [chatTabCloseBinding(b["tmux.tab.close"].key, closeChatTabTmuxCommand)] : []),
    ...(b["tmux.tab.rename"] ? [chatTabRenameBinding(b["tmux.tab.rename"].key)] : []),
    ...layoutBind("tmux.layout.workspaceSplit", "workspace-split"),
    ...layoutBind("tmux.layout.workspaceClose", "workspace-close"),
    ...layoutBind("tmux.layout.workspaceReset", "workspace-reset"),
    ...layoutBind("tmux.layout.tasksToggle", "tasks-toggle"),
    ...layoutBind("tmux.layout.opsToggle", "ops-toggle"),
    ...layoutBind("tmux.layout.terminalToggle", "terminal-toggle"),
    ...layoutBind("tmux.layout.zenToggle", "zen-toggle"),
    ["bind-key", "f", "run-shell", `${envStr}${invStr} quick-create --session '#{session_name}'`],
    ["bind-key", "u", "display-popup", "-E", openUrlTmuxCommand],
  ])
}
