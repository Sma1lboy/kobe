# Keybindings — boundaries, conflicts, conventions

Single source of truth for "what keys do what, where, and why."
Outer opentui bindings live in [`packages/kobe/src/tui/context/keybindings.ts`](../packages/kobe/src/tui/context/keybindings.ts) — `KobeKeymap` is the canonical table for those. Users can override most of them via `~/.kobe/settings/keybindings.yaml` (see "User customization" below). **Do not hardcode outer-TUI chord strings outside that table.** Pane code reaches in via `bindByIds({ id: handler })`; the help dialog (F1) reads every row, while the status bar reads only rows whose friendly `hint` has not opted out with `status: false`. A single edit there is enough to update chord, Help copy, and footer eligibility.

> **Outer-monitor retirement (2026-06; record `docs/design/app-retirement.md` in git history).** The opentui outer monitor (`app.tsx`) is gone, and the keymap rows whose only registering surface died with it were removed: `palette.open` (the command palette itself was deleted), `app.copy_or_quit` (the Ctrl+C arm-to-quit machinery + its status-bar chip), `focus.next` / `focus.prev` (tab pane-cycling — pane focus is tmux's job now; **`focus.next` revived 2026-07-06** for the pure TUI, on `f4`, forward-only — see the pure-TUI navigation decision log), and `pane.resize-grow` / `pane.resize-shrink` (the mouse `ResizableEdge` was the last resize surface). Rows that document live tmux-layer or pane-host behavior (`focus.numeric`, `focus.sidebar`, the Workspace chat/question rows, terminal rows) stay. References to those removed rows below in the historical decision log are kept as history.

Direct-tmux handover bindings are the explicit exception: they are real tmux server/window bindings installed by [`packages/kobe/src/tui/panes/terminal/tmux.ts`](../packages/kobe/src/tui/panes/terminal/tmux.ts). Their DEFAULT chords live in [`packages/kobe/src/tmux/keybindings.ts`](../packages/kobe/src/tmux/keybindings.ts) (`TMUX_SINGLE_BINDING_DEFAULTS` / `TMUX_FOCUS_DEFAULTS`, user-overridable via `tmux.*` ids — see "User customization" below), and the in-session Tasks pane footer ([`packages/kobe/src/tui/tasks-pane/host.tsx`](../packages/kobe/src/tui/tasks-pane/host.tsx)) renders from the same resolved set. Change a handover default in the defaults table, not at the install site.

---

## The 4-pane scope model

There are four panes:

| Ordinal | Pane        | `scope` value | Focus chord |
| ------- | ----------- | ------------- | ----------- |
| h       | Sidebar (TASKS) | `"sidebar"`   | `ctrl+h`    |
| j       | Workspace (chat / files preview) | `"workspace"` | `ctrl+j`    |
| k       | Files       | `"files"`     | `ctrl+k`    |
| l       | Terminal    | `"terminal"`  | `ctrl+l`    |

`ctrl+hjkl` is **global** (`scope: "global"`, id `focus.numeric`). It fires from any pane, including when the chat composer has the
keyboard. ctrl+letter chords map to stable C0 control bytes that every terminal sends without protocol negotiation, so the chord
works without iTerm CSI-u, kitty keyboard, tmux extended-keys, or any per-user setup. The only thing that suppresses it is an
open dialog — binding registrations include `enabled: dialog.stack.length === 0` so dialog-internal keys
(esc to dismiss, enter to confirm) win on the dialog stack.

`ctrl+q` from any non-sidebar pane jumps back to the sidebar (`focus.sidebar`). In the native workspace, a second `ctrl+q`
from sidebar focus exits the attached native UI, matching the direct-tmux handover's two-stage detach shape. `esc` is
**not** a global "back to sidebar" — it would yank focus out of the chat composer mid-edit. ESC is reserved for: closing
the top dialog (DialogProvider) and interrupting a streaming turn (Chat). Sidebar focus owns plain `q` (quit confirm)
and plain `n` (new task).

## Binding categories — three flavours

1. **Global, modifier-prefixed** (e.g. `ctrl+1..4`, `ctrl+,`, `ctrl+k`, `f1`, `ctrl+shift+q`). Always-on. Modifier keys never reach
   the composer textarea, so they can't collide with typing. Default home for cross-pane app verbs.
2. **Pane-scoped, plain letters** (e.g. sidebar `n` / `q` / `s`, files `[`/`]`, terminal `j`/`k`). Single-character chords. Gated
   at the call site with `enabled: focusedPane() === <scope>`. Plain letters typed in the composer are LITERAL TEXT — the gate is
   what keeps them from intercepting input.
3. **Doc-only** (no chord registered, but a `KobeKeymap` row exists for help/status display). Used when the chord lives inside a
   renderable's own keybinding map (textarea's `keyBindings` prop, slash-dropdown's `onKeyDown`). Examples: `chat.send` (`enter`),
   `chat.newline` (`shift+enter`), `chat.steer` (`ctrl+enter`).

## The boundary rule

> **Every plain-letter binding MUST be pane-scoped.** Every global binding MUST be modifier-prefixed.

Violating this means the chord either steals composer typing (plain letter as global) or never fires (modifier-prefixed but
gated to one pane). When in doubt, look at the `scope` field on the keymap entry and the `enabled` predicate at the registration
site — they should agree.

## Known overlaps + how they resolve

| Chord            | Overlap                                 | Resolution                                                                                                                                                                          |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctrl+hjkl`      | `focus.numeric` (global) — works without any terminal config | Pane focus uses `ctrl+hjkl` (vim-style direction keys mapped onto pane ordinals h/j/k/l = sidebar/workspace/files/terminal). **Why not ctrl+digit?** ctrl+digit needs CSI-u / kitty keyboard support; even with kobe's `useKittyKeyboard: {}` enabled, iTerm2 has a quirk where ctrl+1 / ctrl+9 / ctrl+0 fall through to a bare digit byte while ctrl+2..8 emit CSI-u correctly. **Why not alt+digit?** Option+digit on macOS gets eaten by launchers like Raycast before reaching the terminal. ctrl+letter has stable C0 control byte mappings that every terminal sends, no protocol negotiation, no per-key quirks. |
| `ctrl+k` palette vs focus | `palette.open` moved to ctrl+p, then the palette was retired with the outer monitor | `ctrl+k` was the palette chord, then the "focus files pane" chord (k = ordinal 3). The command palette is gone (2026-06 retirement); `ctrl+k` keeps its `focus.numeric` role. |
| `esc`            | dialog dismiss vs chat interrupt        | `DialogProvider` registers a higher-priority `escape` binding while a dialog is open; dialog pop wins. With no dialog and chat focused while streaming, `chat.interrupt` cancels the turn. Idle ESC is a no-op so the composer doesn't lose focus mid-edit. |
| `ctrl+c`         | copy selection vs double-tap quit       | RETIRED with the outer monitor (`app.copy_or_quit` + `useKobeKeybindings` are gone). In pane hosts `ctrl+c` is host-local (Ops/settings hosts exit); inside a Handover the terminal/tmux own it. |
| `ctrl+o`         | shell flow-control history (`^O`) / editor-open convention | Global "open active task in editor." We use a modifier chord because it must work from every pane without stealing composer text. The handler is a no-op when no active task or editor opener is available. |
| `tab`            | pane cycle vs shell completion          | `tab` stays UNBOUND at the pane level — it reaches the focused renderable untouched. Pane cycling is `focus.next` on `f4` only (pure TUI, 2026-07-06, see decision log). `tab` and `shift+tab` were both tried for the cycle that day and cut the same day: the cycle path always lands on the workspace terminal, which must keep tab as shell/engine completion (so tab-cycling trapped there every lap and typed a `\t` into the engine composer on arrival), and shift+tab is claude's plan-mode chord. |
| `[` / `]`        | sidebar view switch vs files tab cycle  | Both pane-scoped (different scopes), so the focused pane wins.                                                                                                                      |
| `ctrl+[` / `ctrl+]` | outer dialog sub-tab cycle vs tmux ChatTab cycle | In the outer TUI, the New Task dialog owns `ctrl+[` / `ctrl+]` locally to switch its sub-tabs. Inside a Handover, the same chords are tmux no-prefix bindings on the dedicated `-L kobe` socket: previous / next ChatTab window. The old self-rendered chat-tab handler is stale; ChatTabs are tmux windows now. |
| `ctrl+w` | readline delete-word vs tmux ChatTab close | Inside a Handover, kobe restores the v0.5 close-tab chord as a tmux no-prefix binding. It closes the current ChatTab window only when another window remains; the final window is protected so `ctrl+w` cannot accidentally destroy the whole Task tmux Session. |
| sidebar letter chords (`j`/`k`/`g`/`G`/`d`/`a`/`r`/`P`/`m`/`i`) vs `/`-search typing | Letter chords are registered in a sidebar-scoped `useBindings` block gated `enabled: focused() && !searchMode()`. When `/` enters search mode the block de-registers, so subsequent letter keys fall through to the inline search input as literal text. `[` / `]` view switch lives in a separate always-on block and keeps firing during search. A second search-only block registers `up`/`down` (filtered-list nav), `enter` (commit), and `esc` (cancel + restore prior selection). |

## tmux passthrough

kobe already enables opentui's kitty / CSI-u keyboard protocol with `useKittyKeyboard: {}`. That lets supporting terminals send
full modifier information for richer chords like `shift+enter`, `ctrl+enter`, `ctrl+pageup`, and ctrl-modified punctuation or
digits. tmux must be told to preserve those extended key sequences instead of translating them back to legacy bytes.

Recommended tmux config:

```tmux
# tmux >= 3.2
set -g extended-keys on
set -as terminal-features ',xterm*:extkeys'
set -as terminal-features ',tmux*:extkeys'
```

Outer-terminal requirements still apply:

- iTerm2: enable profile-level "Report keys using CSI u" / CSI-u key reporting. Even then, iTerm2 has a known ctrl+1 / ctrl+9 /
  ctrl+0 quirk, so kobe does not rely on ctrl+digit for core navigation.
- Kitty, foot, Ghostty, and recent Terminal.app builds generally answer the keyboard-protocol enable sequence without extra kobe
  config, but local keybindings in the terminal app can still intercept a chord before tmux sees it.
- macOS launchers and terminal application shortcuts can swallow Option/Cmd chords globally. No tmux setting can pass through a
  shortcut that never reached tmux.

The invariant for kobe-owned shortcuts remains: primary navigation must work without this setup. `ctrl+hjkl` pane focus is kept as
the direct pane chord because ctrl+letter maps to stable C0 bytes that tmux can pass in legacy mode. Extended-key passthrough is for
the shortcuts where the terminal protocol is the only way to distinguish intent, not a dependency for basic operation.

## Direct-tmux handover keys

Normal startup opens directly into the task's tmux session. These keys are installed on kobe's isolated tmux socket, not the user's global tmux config:

| Chord | Scope | Action |
| --- | --- | --- |
| `ctrl+h/j/k/l` | no-prefix tmux | Move between Tasks / engine / Ops / shell panes directionally. Edge-guarded: each bind is `if-shell -F "#{?window_zoomed_flag,1,#{?pane_at_<edge>,,1}}" "select-pane -<dir>"`, so a press at the window edge is a no-op instead of tmux's default wrap-around (ctrl+h on the leftmost Tasks pane used to teleport to the rightmost pane) — EXCEPT while a pane is zoomed: zoom sets all four `pane_at_*` flags, so the outer conditional lets a zoomed press fall through to plain select-pane (unzoom + move, the pre-guard behavior). The guard is on the command side, so user-overridden `tmux.focus` keys keep it. The LEFT-edge press has a fallback instead of a plain no-op — restore/focus the Tasks rail via `kobe layout tasks-restore` — and that fallback is `run-shell -b` + gated on active-pane `@kobe_role` ≠ `tasks`: a foreground run-shell stalls tmux's whole command queue for a full CLI startup, so pressing ctrl+h while already sitting in the Tasks pane (the muscle-memory spam case) used to freeze the client, with rapid presses compounding into multi-second hangs. |
| `ctrl+q` | no-prefix tmux | Two-stage: focus the current window's Tasks pane; press again from the Tasks pane to detach to the launching shell (session keeps running). `prefix d` / `ctrl+b d` still detaches in one step. No-op in full-window tabs that are not a workspace (file preview / editor windows — no Tasks pane, no engine pane) and on `@kobe_surface` pages: restoring there would graft a Tasks rail into the full-width view. |
| `ctrl+t` | no-prefix tmux | Create a same-engine ChatTab window for the current task/worktree. |
| `ctrl+shift+t` | no-prefix tmux, terminal-dependent | Prompt for engine, then create a ChatTab window. |
| tmux `prefix T` | tmux prefix fallback | Same engine picker as `ctrl+shift+t`, for terminals that do not forward the shifted control chord. |
| `ctrl+[` / `ctrl+]` | no-prefix tmux | Previous / next ChatTab window. |
| `ctrl+w` | no-prefix tmux | Close the current ChatTab window if another window remains. |
| `F2` | no-prefix tmux | Rename the current ChatTab window. |
| tmux `prefix s` | tmux prefix | Add a temporary shell split in the middle workspace area. The current ChatTab caps at four middle panes: engine + up to three aux shells. |
| tmux `prefix x` | tmux prefix | Close the focused workspace aux split, or the most recent aux split when focus is elsewhere. The engine pane is never closed by this binding. |
| tmux `prefix r` | tmux prefix | Reset the middle workspace area by closing every temporary aux split in the current ChatTab. |
| tmux `prefix a` | tmux prefix | Hide/restore the Tasks pane by moving it to a background tmux window, preserving the Tasks process. |
| tmux `prefix o` | tmux prefix | Toggle the file/Ops pane in the current ChatTab. Hiding it closes only the kobe-owned Ops pane; showing it rebuilds that pane against the current engine pane. |
| tmux `prefix z` | tmux prefix | Hide/restore the terminal pane by moving it to a background tmux window, preserving its shell process and scrollback. |
| tmux `prefix space` | tmux prefix | Toggle Zen mode — collapses **every** ChatTab in the session to its engine pane (hides the file/Ops and terminal panes, and the Tasks rail unless Settings → General → "Keep Tasks pane in zen mode" is on). Zen is session-wide and persistent: tabs you switch to stay collapsed, and a newly created ChatTab opens collapsed too. A second press restores exactly the panes zen hid across all tabs. Also reachable via the `zen` chip above the file list (enter-only, since entering hides that pane). |
| tmux `prefix f` | tmux prefix | Open the prompt-only quick-task page (asks for just a prompt; repo / engine / base branch default from the current task). |

Inside the Tasks pane itself, plain-letter task actions are pane-local: `n` new task, `s` Settings, `x` the standalone worktree-management page (`worktrees.open.sidebar` — cross-project audit + delete, no global companion chord since it's a sidebar-launched utility like `n`, not an anywhere-reachable surface like Settings; kept out of the trimmed footer legend, reachable via F1 full help; not `w`/`e`, which `keymap-slot-parity.test.ts` uses as a free-key example for `sidebar.nav` override testing), `u` update page when an update is available, `o` open worktree, `t` toggle task sort (default/manual vs recent), `a` archive/unarchive, `d` delete, `r` title, `b` branch, `v` engine, `?` collapse/expand the keys legend (KV-persisted; clicking the `── keys ──` header does the same), and `[` / `]` Working session vs Archives. `ctrl+p` cycles the global project filter (`all` → each saved project), synced across every task session through the daemon's `ui-prefs` channel, without restoring repo grouping: PROJECTS rows stay visible as main-session entries, while the TASKS section narrows to the selected repo and still composes with `/` search. `Right` (`tasks.focusEngine`) re-focuses the current window's engine pane — the role-tagged `@kobe_role=claude` pane via `claudePaneIdStrict`, the inverse of the ctrl+h jump to the rail — and no-ops outside tmux (no `$TMUX_PANE`). These host-level letters (and Right) gate on BOTH an empty dialog stack and the sidebar's `/`-search being inactive — while a query is being typed they fall through as literal text (Right keeps moving the search input's cursor); move-mode is unaffected, since it only owns `j`/`k`/`enter`/`esc`. Archive/delete also kill the task's cached tmux session when present, because the legacy outer monitor no longer owns that cleanup path.

The Tasks/Ops panes are version-tagged with `@kobe_pane_version`. After an upgrade, `ensureSession` respawns stale kobe-owned panes in place while preserving the engine pane and ChatTab windows. Do not use `kobe reset` as the normal update path; reset is the runtime-recovery fallback for wedged tmux/daemon state.

## User customization — `~/.kobe/settings/keybindings.yaml`

Users can rebind most chords without touching the code. The config lives in the
hand-authored settings directory (`~/.kobe/settings/`, distinct from the
machine-written KV blob) and is loaded ONCE per process at TUI boot by
`applyUserKeybindings()` ([`src/tui/context/keybindings-user.ts`](../packages/kobe/src/tui/context/keybindings-user.ts)),
which mutates the matching `KobeKeymap` rows in place. Because every pane
registers through `bindByIds` and the F1 help dialog / status bar render from
the same table, one mutation re-points every surface — chord, Help copy, and
footer hint follow automatically (overridden rows get their `hint.keys`
refreshed; an unbound row loses its hint). Restart kobe — or respawn the pane —
to apply edits. Pure parsing/validation logic lives in
[`src/tui/lib/keymap-overrides.ts`](../packages/kobe/src/tui/lib/keymap-overrides.ts)
(vitest-covered, no opentui imports, mirroring the keymap-dispatch split).

```yaml
bindings:                 # applies on every platform
  chat.fork.new: ctrl+g   # string = one chord
  sidebar.select: [enter] # list  = several chords (all fire the action)
  files.createPR: null    # null / [] = unbind (hint disappears too)
darwin:                   # platform overlay — wins over `bindings` per id
  bindings:               # (aliases: macos / mac; also: linux, windows)
    palette.open: [cmd+p, ctrl+p]
linux:
  bindings:
    palette.open: ctrl+p
```

Semantics and guard rails:

- **Ids come from `KobeKeymap`** — press F1 for the live list, or open
  Settings → Keybindings (read-only section showing the config path, applied
  overrides, and every load warning; warnings also go to `console.warn` →
  the pane log).
- **Chord grammar mirrors `matchKey()`**: `mod+...+key`, modifier aliases
  (`control`/`command`/`meta`/`option`…) are canonicalized to
  `ctrl`/`cmd`/`alt`/`shift` in the dispatcher's order. `esc`→`escape`,
  `pgup`→`pageup`. `left`/`right` are the arrow keys; left vs right
  *modifier* keys cannot be distinguished by terminal protocols, so there is
  no `lctrl`/`rcmd` syntax.
- **The boundary rule is enforced on user input**: a bare single character on
  a `global` / `workspace` / `terminal`-scope binding is dropped with a
  warning (it would steal typed input). `shift+<letter>` chords are rejected
  (terminals deliver shift+letter as a plain character — see the KOB-74
  decision log below).
- **Conflicts warn but apply**: an override colliding with another binding in
  an overlapping scope logs "last registration wins; consider a different
  chord".
- **tmux-layer session keys use the same file** via `tmux.*` ids resolved by
  [`src/tmux/keybindings.ts`](../packages/kobe/src/tmux/keybindings.ts) and
  installed by `ensureSession` (overridden defaults are `unbind-key`'d first,
  so a long-lived server doesn't keep both chords): `tmux.tab.new` (ctrl+t),
  `tmux.tab.chooseEngine` (ctrl+shift+t — shift+letter IS allowed here, tmux
  binds `C-S-…` on extended-keys terminals), `tmux.tab.prev`/`tmux.tab.next`
  (ctrl+[ / ctrl+]), `tmux.tab.close` (ctrl+w), `tmux.tab.rename` (f2),
  `tmux.detach` (ctrl+q two-stage), prefix-scoped layout controls
  (`tmux.layout.workspaceSplit` = `s`, `tmux.layout.workspaceClose` = `x`,
  `tmux.layout.workspaceReset` = `r`, `tmux.layout.tasksToggle` = `a`,
  `tmux.layout.opsToggle` = `o`, `tmux.layout.terminalToggle` = `z`), and
  `tmux.focus` — a POSITIONAL group of exactly 4 chords in order
  left/down/up/right (default ctrl+h/j/k/l). One chord per single id; `null`
  skips installing the binding. Extra guard rails: `cmd+` chords are rejected
  (Command never reaches tmux). Bare keys are rejected for no-prefix root ids
  unless they're F-keys because root bindings live in every pane and would
  shadow typing; prefix-scoped layout ids may use bare keys. The Tasks-pane
  footer legend and the tmux `status-right` hint render from the resolved set, so overrides show
  their own chords. Overrides apply when a session is (re)built, not to a
  session that's already running. The `prefix T` / `prefix f` rows stay fixed.
- **Positional (slot-layout) ids are rebindable via slot dispatch**: the
  direction-multiplexed ids — one id, several chords, the action depends on
  WHICH chord fired — used to be fixed because their handlers read
  `evt.name`. They now dispatch on the matched chord's **slot** (its index in
  the id's `keys` array: `bindByIds` assigns it, `dispatchKeyEvent` passes it
  to the handler as a second argument), so an override just has to respect the
  id's positional layout, validated in `SLOT_CONTRACTS`
  ([`src/tui/lib/keymap-overrides.ts`](../packages/kobe/src/tui/lib/keymap-overrides.ts)) —
  same idea as `tmux.focus`'s exactly-4-chords rule. The direction ids are
  **alternating pairs**, so any even chord count works; `app.quit` is a
  1-or-2 chord layout (a wrong count warns and keeps the default;
  `null`/`[]` still unbinds):

  | id | slot layout (even slots, odd slots) | default keys |
  |---|---|---|
  | `sidebar.nav` | down, up | `j, k, down, up` |
  | `files.nav` | down, up | `j, k, down, up` |
  | `sidebar.search.nav` | down, up | `down, up` |
  | `files.hierarchy` | collapse, expand | `h, l, left, right` |
  | `sidebar.view` | previous view, next view | `[, ]` |
  | `files.tab` | previous tab, next tab | `[, ]` |
  | `app.quit` | quit confirm, hard exit (optional) | `q, ctrl+q` |

  ```yaml
  bindings:
    sidebar.nav: [w, s]                  # 2-chord nav: w=down, s=up
    files.hierarchy: [left, right]       # arrows only
    files.tab: [ctrl+left, ctrl+right]   # pairs can be modifier chords
  ```

- **Fixed (not rebindable)**: listed in `FIXED_BINDING_IDS` with reasons —
  `focus.numeric` (positional h/j/k/l → pane set mirroring the tmux-layer
  `ctrl+hjkl` bindings; rebind `tmux.focus` instead),
  `sidebar.goto`/`sidebar.pin`/`sidebar.localMerge` (the handler fires on
  `evt.shift` — `shift+<letter>` chords are inexpressible in the chord
  grammar, so a rebind could never carry the shifted half), and
  `chat.question.nav`/`chat.question.pick-number` (no live registration site
  since the legacy Chat pane's question picker was removed — display-only
  rows; if the picker returns, implement it with slot dispatch before
  unlocking). Doc-only rows (`keys: []`, e.g. composer enter/shift+enter)
  also can't be overridden.

## Adding a new binding — checklist

1. Decide the flavour (global/modifier vs pane-scoped/letter).
2. Add the row to `KobeKeymap`. Set `id`, `scope`, `keys`, `description`, optional `hint`, optional `category`. Use `hint.status: false` when the chord belongs in Help but not in the always-visible footer.
3. Wire the handler:
   - Global → register inside `useKobeKeybindings` (in `keybindings.ts`) or as a top-level `useBindings` block in
     `app.tsx`.
   - Pane-scoped → register in the pane's own `useBindings` (sidebar uses its `controller.ts`, files has `keys.ts`,
     workspace uses `Chat.tsx`'s pane block, app.tsx hosts the sidebar-only ones for `n` / `q` / `s` / etc).
   - In every case use `bindByIds({ "<id>": handler })` so the chord comes from `KobeKeymap`, not a string literal.
4. Gate appropriately:
   - Pane-scoped: `enabled: focusedPane() === "<scope>" && dialog.stack.length === 0`.
   - Global: `enabled: dialog.stack.length === 0` is the usual minimum.
5. If the chord lives inside a textarea's `keyBindings` prop or a renderable's `onKeyDown`, leave the keymap row's `keys: []`
   (doc-only) so the help dialog still advertises it.

## Debugging "why didn't my chord fire?"

In rough order of likelihood:

1. **Dialog open?** Pretty much every binding gates on `dialog.stack.length === 0`. With a dialog on top, only the dialog's own
   bindings (esc / ctrl+c / inline submit) fire.
2. **Wrong pane focused?** Pane-scoped bindings only fire when their pane owns focus. Check `focusedPane()` in dev: status bar's
   left section label — `Tasks:` / `Chat:` / `Files:` / `Terminal:` — tracks focus exactly.
3. **Plain letter caught by an input?** If the binding is plain `q` and the composer textarea has focus, the textarea consumes
   the keystroke as text. Pane-scoped binding rules above prevent this in practice; if it's a global plain letter, it's already
   the bug — convert to a modifier chord or pane-scope it.
4. **Shadowed by a higher-priority binding?** `useBindings` calls register in mount order; later registrations win on the same
   chord. Look for two registrations with overlapping chords (the docs/JSON doesn't catch this — has to be read).
5. **Terminal byte sequence mismatch?** Some terminals deliver `ctrl+shift+q` as the same bytes as `ctrl+q`; the keymap layer
   drops the shift modifier on letter keys (see `lib/keymap.tsx`'s normalizer comment). If you registered both, both fire.

## When to update this doc

Whenever you discover, debug, or resolve a keybinding-boundary issue. Treat it as the place a future agent / Jackson can grep for
"why does ctrl+1 do X here but Y there." The doc is small on purpose — the goal is "every keybinding decision has a one-paragraph
explanation findable in this file"; if a section sprawls, the underlying design is probably wrong.

## Decision log

### Quick-fork chord (KOB-74) — why `ctrl+f`, not `ctrl+shift+t`

KOB-74 asked for `ctrl+shift+t` ("new tab" in browsers, restoring a closed tab; semantic
match for forking into a new task). The keymap layer normalizes terminal-delivered keys
and **drops the `shift+` modifier on letter keys** (see `lib/keymap-dispatch.ts` —
`if (evt.shift && name && name.length > 1) mods.push("shift")`). Terminals deliver
shift+letter as uppercase, not as a modifier event, so `ctrl+shift+t` and `ctrl+t` produce
identical match candidates. `ctrl+t` is already `chat.tab.new` (open a sibling chat tab in
the same task), so registering quick-fork on `ctrl+shift+t` would either collide silently
or steal the existing chord — neither is acceptable.

Candidate chords considered (workspace-scoped, modifier-prefixed, free in the keymap):

- `ctrl+f` — "fork." ctrl+letter has stable C0 byte mappings (`0x06`) in every terminal,
  no CSI-u / kitty-keyboard / iTerm quirks. The composer's textarea would normally read
  `ctrl+f` as emacs-style forward-char, but our `useBindings` listener fires first and
  calls `preventDefault()` so the textarea never sees it.
- `alt+t` — keeps the "t" semantics. Option+letter on macOS produces a special character
  (Option+T → †) at the OS level, which the keymap layer surfaces as `alt+t` via
  `evt.option`. Reliable in most setups, but Option+digit is a known macOS-launcher hazard
  (Raycast/Karabiner) and Option+letter sometimes follows; ctrl+letter sidesteps it.
- `ctrl+b` — "branch." Free, but less mnemonic for "fork a task" vs "create a branch."

Landed on `ctrl+f`. The chord is workspace-scoped (only fires when chat owns focus) so it
doesn't shadow the global focus-numeric set. Decision: KOB-74. See `context/keybindings.ts`
→ `chat.fork.new` for the registration.

### Embedded-terminal engine-choose chord — why `ctrl+e`, not `ctrl+shift+t`

tmux's chattab has a "prompt for engine, then open a tab" flow bound to `ctrl+shift+t`
(`chattab.ts`'s `chatTabChooseEngineBindings`) — real tmux `bind-key -n` distinguishes the
shifted chord because it negotiates the terminal's extended-keys protocol directly. The
pure-tui embedded terminal (`panes/terminal/`) hits the exact same collision KOB-74 already
hit: the keymap layer drops `shift+` on letter keys (`lib/keymap-dispatch.ts`), so
`ctrl+shift+t` and `ctrl+t` (`chat.tab.new`) are indistinguishable there. Same fix shape as
KOB-74: gave the action its own ctrl+letter chord instead of the shifted one. Landed on
`ctrl+e` — mnemonic ("engine"), free across every scope, and matches the chord the new-task
dialog already uses to cycle its own engine selector (`ctrl+e` in
`component/new-task-dialog/dialog.tsx`). Registration: `chat.tab.chooseEngine` in
`context/keybindings-chat.ts`; reserved from PTY passthrough in `panes/terminal/keys-pure.ts`.

### Workspace split chords — `ctrl+\` / `ctrl+=` / `F3` (`workspace.split.*`)

tmux splits with `prefix %` (side-by-side) and `prefix "` (stacked); kobe has no prefix
key, so splits get direct chords (owner request 2026-07-06): `ctrl+\` reads as a
vertical divider → new leaf to the RIGHT; `ctrl+=` reads as horizontal strokes → new
leaf BELOW. Groups nest like tmux panes (same-orientation splits become siblings;
cross-orientation splits nest a group). **Naming is deliberately content-neutral**
(owner emphasis, twice): the split tree (`workspace/split-core.ts`) is generic over
leaf content ("leaf", never "pane" — that word is taken by the outer TUI panes, see
CONTEXT.md) — terminals are just the first adapter (`workspace/TerminalSplit.tsx`,
new leaves run the user's shell); future leaf types plug in without renaming ids.
`F3` cycles leaf focus in reading order (tmux `prefix o`): every useful ctrl+letter is
either engine passthrough (owner decision 2026-07-06) or taken, and F-keys already
carry the tab vocabulary (F2 rename). Costs accepted and documented:
- reserving `ctrl+\` takes SIGQUIT away from the embedded shell (rarely used; `kill -QUIT` remains);
- both split chords need the kitty keyboard protocol — legacy terminals cannot encode
  `ctrl+=` at all (there is no C0 byte for it), same dependency class as the
  `ctrl+h`/`ctrl+j` aliases in `lib/keymap-dispatch.ts`.
An exited leaf removes itself and its group collapses (tmux behavior); the last leaf's
exit falls back to the tab-level behavior: the tab closes (engines run INSIDE the
user's shell since 2026-07-10 — exiting the vendor lands on the shell prompt, and only
the shell's own exit ends the tab; the last remaining tab recycles as a fresh engine).
`ctrl+w` is contextual (owner decision 2026-07-06): while split it closes the
ACTIVE LEAF (`workspace.split.close` — the innermost thing, VS Code/iTerm/Warp
convention, tmux `prefix x`); unsplit, the entry is disabled and the chord falls through
the LIFO stack to `chat.tab.close`.

**Naming (owner corrections 2026-07-06):** a NORMAL (single) tab is `tab {n}`
(`terminal.tab.defaultTitle`, overridden by the auto first-prompt title and F2 rename); only
a SPLIT tab is a `group {n}` (`terminal.tab.groupTitle`) — the "group" is the tab that groups
several leaves. Each split leaf carries its OWN name in its corner
tag, same flow shape: manual rename wins; the ENGINE leaf's default is the conversation's
first-prompt title (the tab's title/autoTitle, so it matches the group label — falling back
to the vendor basename "claude" before the first prompt), and a split SHELL leaf's default
is a generic "shell". Duplicate defaults get a reading-order suffix ("shell 2"). `F2` is
contextual exactly like `ctrl+w`: while split it renames the ACTIVE LEAF
(`workspace.split.rename`); unsplit it falls through to `chat.tab.rename`. The original
shipped shape (every leaf tagged `group {n}`) misread the vocabulary — "group" names the
whole tab, never a single leaf.

### Pure-TUI pane navigation (2026-07-06) — cycle, dead slot, Right parity

The `KOBE_TUI` workspace host is 3-pane (sidebar | embedded engine terminal | files) and the
embedded terminal passes `ctrl+hjkl` through to the engine — so the navigation matrix had a
hole: workspace → files always cost two hops (`ctrl+q` to sidebar, then `ctrl+k`). Fixes,
all in this pass:

- **`focus.next` (`f4`)** — pane cycle through the host's real panes
  (sidebar → workspace → files → wrap), finally wiring the `cycle()` that
  `context/focus.tsx` designed for this. `f4` is in `RESERVED_GLOBAL_CHORDS`, so the
  chord behaves IDENTICALLY from every pane, including inside the embedded terminal —
  closing the workspace → files hole (it's the one cross-pane chord besides `ctrl+q`
  reachable there). F-key chosen because F2/F3/F5 already carry kobe's
  rename/split/reset vocabulary in the terminal; engines don't use F4.
  **Why not `tab`** (tried first, cut same-day after owner testing): the cycle path
  always lands on the workspace terminal, which must keep `tab` as shell/engine
  completion — so a tab-cycle trapped there every lap ("tab stops working"), and worse,
  the arrival keystroke typed a literal `\t` into the engine composer. A chord that
  half-works is worse than absent; one key, one meaning. **Why not `shift+tab`
  reverse**: claude's plan-mode chord — cycling panes in one pane and toggling
  plan-mode in another reads as a conflict. Forward-only (tmux `prefix o` shape);
  with 3 panes, prev is just `f4` twice.
- **`ctrl+l` dead slot** — `focus.numeric` has 4 chords but the host had 3 slot targets,
  so `ctrl+l` was a no-op. It now maps to workspace: the middle column IS the terminal
  in this host, so tmux-layer muscle memory ("l = terminal") lands somewhere sensible.
- **Sidebar `Right` → workspace** — the tmux Tasks pane's `tasks.focusEngine` row,
  registered by the pure-TUI host too (gated on `/`-search inactive, same as tmux).
  The host cycles over its own pane list, not `PANE_ORDER` — that includes `"terminal"`,
  which this host never mounts, and focus must never land on an unmounted pane.
- **`worktrees.open.sidebar` (`x`) / `tasks.update` (`u`) → in-place page swaps, not
  tmux windows** (daemon issue #23). In the tmux Tasks pane these chords spawn a
  standalone `kobe worktrees` / `kobe update-page` tmux window. The pure-TUI
  workspace host reuses the SAME ids/chords, gated the same way (sidebar focus, no
  dialog, no search), but swaps `WorktreesPage` / `UpdatePage` in as the host's own
  root — same shape as `settingsOpen`. `UpdatePage` needed an `onClose` seam for
  this: its close path used to call `process.exit(0)` directly (fine for a
  standalone tmux window; fatal for an in-process host). The post-update
  self-replace exit (`runUpdater()`'s `renderer?.destroy()` + `process.exit(code)`
  after the shell updater runs) is UNCHANGED in both hosts — an embedded swap can't
  survive replacing the running binary any more than a standalone window can — but
  it now surfaces a status line (`update.statusRunningUpdater`) before tearing the
  renderer down instead of exiting silently.

### Zen toggle chord (issue #18) — why `F6`

Zen mode itself (the pure-TUI host hiding its Files column, `useState` in `tui-react/workspace/
host.tsx`) already shipped — the sidebar's `☯ ZEN` chip toggles it on click, and stays visible
by design as the exit affordance (tmux parity). The only gap was keyboard: no chord, mouse-only.
`F6` fills it: `workspace.zenToggle` continues the F2 (rename) / F3 (split) / F4 (pane cycle) /
F5 (reset) row and was unclaimed at the time of writing — the embedded-terminal cluster only
reserves through `f5`, and no other pure-TUI row uses an F-key past that point. Registered in
`RESERVED_GLOBAL_CHORDS` (`panes/terminal/keys-pure.ts`) so it fires identically from inside the
embedded terminal, same tier as `focus.next` in `host-keybindings.ts`'s first `useBindings` block
(gated only on `pagesClosed`, provably reachable from every pane). Deliberately NOT
`tmux.layout.zenToggle` (`space`, `keybindings-chat.ts`) — that row is the tmux-layer's own
display toggle, a separate contract the pure-TUI host doesn't touch.

### Pane focus chord — why `ctrl+hjkl`, not `ctrl+1..4`

We iterated through three candidates before landing on `ctrl+hjkl`. Recording the journey here so the next agent (or Jackson) doesn't
re-derive it.

1. **`ctrl+1..4`** — first attempt, mirrors VSCode/iTerm pane focus muscle memory.
   - **Conflict 1** (resolved): `chat.tab.pick` was registered on the same chords. In v0.6, self-rendered chat-tab picking is gone; ChatTab navigation lives inside tmux as `ctrl+]` / `ctrl+[` previous / next window.
   - **Conflict 2** (load-bearing): legacy terminal mode doesn't propagate the ctrl modifier on digit keys — pressing `ctrl+1`
     just sends the byte `1`. The ctrl-digit chord requires the **CSI-u / kitty keyboard** protocol, which:
     - opentui can request via `useKittyKeyboard: {}` on `render()`. Done.
     - The terminal must respond to. **iTerm2 has a quirk** where ctrl+1 / ctrl+9 / ctrl+0 silently fall through to a bare digit
       byte even with CSI-u enabled — only ctrl+2..8 emit the proper sequence.
     - tmux must pass the sequences through with `set -g extended-keys on` (tmux ≥ 3.2) + `set -as terminal-features 'xterm*:extkeys'`.
   - Verdict: too many config layers; ctrl+1 works for nobody by default.

2. **`alt+1..4`** — second attempt. Always-works because alt+digit produces a stable two-byte `ESC<digit>` sequence in legacy mode,
   no protocol negotiation needed.
   - **Conflict**: macOS launchers (Raycast, Karabiner, Alfred) commonly intercept Option+digit globally before it reaches the
     terminal. Many users (including Jackson) have alt/option/cmd entirely committed to other software.
   - Verdict: works in theory, doesn't reach kobe in practice on heavily-customized macOS setups.

3. **`ctrl+hjkl`** — final landing. ctrl+letter chords have stable C0 control byte mappings:
   - `ctrl+h = 0x08` (BS)
   - `ctrl+j = 0x0a` (LF)
   - `ctrl+k = 0x0b` (VT)
   - `ctrl+l = 0x0c` (FF)

   These bytes are sent by every terminal, every tmux config, every shell — no protocol, no quirks, no setup. The chord conflicts
   with editor commands (ctrl+h = backspace, ctrl+l = clear screen, etc.) but our `useBindings` listener sees the keypress before
   the textarea's editor handler, and once the chord switches focus, the textarea isn't focused anymore — so the conflict never
   manifests in practice.

   `ctrl+k` was previously the command palette chord (`palette.open`). Freed and reassigned; palette moved to `ctrl+p` / `cmd+p`
   (vscode/Cursor convention).

   Mapping is positional (h/j/k/l = ordinal 1/2/3/4), not directional. The pane title's bold prefix shows the chord letter to make
   the chord discoverable from a glance.

**Lesson for the next chord-design pass**: prefer ctrl+letter over ctrl+digit / alt+digit / cmd+digit. Letters Just Work; digits
need protocol upgrades; modifiers other than ctrl get hijacked by user-space launchers. Pick a single-modifier ctrl+letter chord
and accept that "this conflicts with shell editor commands" is acceptable when the binding's intent is to MOVE focus AWAY from
the input that would consume it.

## Embedded terminal passthrough (2026-07-06, issue #16)

The terminal-in-the-middle center column forwards **maximal** input to the
engine CLI. `RESERVED_GLOBAL_CHORDS`
([`panes/terminal/keys-pure.ts`](../packages/kobe/src/tui/panes/terminal/keys-pure.ts))
shrank to the minimum kobe cannot give up while the terminal is focused:

| chord | owner |
|---|---|
| `ctrl+q` | THE escape hatch back to the tasks list (KOB-208) |
| `ctrl+t` / `ctrl+w` / `ctrl+]` / `ctrl+[` / `F2` | terminal tab management (PTY chattab) |
| `ctrl+e` | new chat tab with a chosen engine (`chat.tab.chooseEngine`) — see the decision log below for why not `ctrl+shift+t` |
| `ctrl+\` / `ctrl+=` / `F3` | workspace splits (`workspace.split.right` / `.down` / `.focus-next`) — see the split decision log below |
| `F4` | pane cycle (`focus.next`) — the one cross-pane chord besides `ctrl+q` that works from inside the terminal (see the pure-TUI navigation decision log below) |
| `F5` | terminal reset (confirm-gated) |
| `F6` | zen toggle (`workspace.zenToggle`) — hides the files column from inside the terminal too (see the zen-toggle decision log below) |
| `ctrl+pgup` / `ctrl+pgdn` | local scrollback (trapped, not reserved) |

Everything else — `shift+tab` (claude plan-mode cycle), `ctrl+hjkl`, `F1`,
`ctrl+p`, `ctrl+,`, `ctrl+r`, alt-combos — passes through to the engine.
The pane registers modifier-variant passthrough bindings (`ctrl+`/`alt+`/
`shift+` forms) so they WIN the LIFO stack against kobe's global bindings;
kobe's globals stay reachable from every non-terminal pane. The pane also
draws no border of its own — the workspace layout wrapper owns the focus
border.
