# Keybindings — boundaries, conflicts, conventions

Single source of truth for "what keys do what, where, and why."
Lives in [`packages/kobe/src/tui/context/keybindings.ts`](../packages/kobe/src/tui/context/keybindings.ts) — `KobeKeymap` is the canonical
table. **Do not hardcode chord strings outside that table.** Pane code reaches in via `bindByIds({ id: handler })`; the help dialog
(F1) reads every row, while the status bar reads only rows whose friendly `hint` has not opted out with `status: false`. A single edit there is enough to update chord, Help copy, and footer eligibility.

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
open dialog — every binding registration in `app.tsx` includes `enabled: dialog.stack.length === 0` so dialog-internal keys
(esc to dismiss, enter to confirm) win on the dialog stack.

`tab` / `shift+tab` cycle the focused pane (`focus.next` / `focus.prev`). Same global rule.

`ctrl+q` from workspace focus jumps back to the sidebar (`focus.sidebar`). `esc` is **not** a global "back to sidebar" — it
would yank focus out of the chat composer mid-edit. ESC is reserved for: closing the top dialog (DialogProvider) and
interrupting a streaming turn (Chat). Sidebar focus owns plain `q` (quit confirm) and plain `n` (new task).

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
| `ctrl+k` palette vs focus | `palette.open` moved to ctrl+p (vscode/Cursor convention) | `ctrl+k` was the palette chord but is now the "focus files pane" chord (k = ordinal 3). Palette is reachable via `ctrl+p` / `cmd+p` instead. |
| `esc`            | dialog dismiss vs chat interrupt        | `DialogProvider` registers a higher-priority `escape` binding while a dialog is open; dialog pop wins. With no dialog and chat focused while streaming, `chat.interrupt` cancels the turn. Idle ESC is a no-op so the composer doesn't lose focus mid-edit. |
| `ctrl+c`         | copy selection vs double-tap quit       | Selection-aware. With text selected → copy via OSC52 + clear. Else first press arms a 1.5s quit window; second press in window = quit. Both behaviours live in `useKobeKeybindings`. `cmd+c` is a synonym for terminals that forward Cmd-chords (Kitty, Ghostty, iTerm2 with "Send Modifier Keys") so the chord doesn't get silently swallowed there. |
| `ctrl+o`         | shell flow-control history (`^O`) / editor-open convention | Global "open active task in editor." We use a modifier chord because it must work from every pane without stealing composer text. The handler is a no-op when no active task or editor opener is available. |
| `tab`            | pane cycle vs textarea focus actions    | `useKobeKeybindings` no-ops `tab` when workspace has focus so the composer's own tab handling (slash completion, indent) wins.                                                      |
| `[` / `]`        | sidebar view switch vs files tab cycle  | Both pane-scoped (different scopes), so the focused pane wins.                                                                                                                      |
| `ctrl+[` / `ctrl+]` | outer dialog sub-tab cycle vs tmux ChatTab cycle | In the outer TUI, the New Task dialog owns `ctrl+[` / `ctrl+]` locally to switch its sub-tabs. Inside a Handover, the same chords are tmux no-prefix bindings on the dedicated `-L kobe` socket: previous / next ChatTab window. The old self-rendered chat-tab handler is stale; ChatTabs are tmux windows now. |
| sidebar letter chords (`j`/`k`/`g`/`G`/`d`/`a`/`r`/`P`/`m`) vs `/`-search typing | Letter chords are registered in a sidebar-scoped `useBindings` block gated `enabled: focused() && !searchMode()`. When `/` enters search mode the block de-registers, so subsequent letter keys fall through to the inline search input as literal text. `[` / `]` view switch lives in a separate always-on block and keeps firing during search. A second search-only block registers `up`/`down` (filtered-list nav), `enter` (commit), and `esc` (cancel + restore prior selection). |

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
