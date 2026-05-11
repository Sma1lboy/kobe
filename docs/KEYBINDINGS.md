# Keybindings — boundaries, conflicts, conventions

Single source of truth for "what keys do what, where, and why."
Lives in [`packages/kobe/src/tui/context/keybindings.ts`](../packages/kobe/src/tui/context/keybindings.ts) — `KobeKeymap` is the canonical
table. **Do not hardcode chord strings outside that table.** Pane code reaches in via `bindByIds({ id: handler })`; the help dialog
(F1) and status bar both read directly from `KobeKeymap`, so a single edit there is enough to update chord, hint, and docs.

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

`esc` from workspace focus also goes back to sidebar (`focus.detach`); `ctrl+q` from workspace is an alternate alias
(`focus.sidebar`). Sidebar focus owns plain `q` (quit confirm) and plain `n` (new task).

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
| `esc`            | dialog dismiss vs `focus.detach`        | `DialogProvider` registers a higher-priority `escape` binding while a dialog is open; dialog pop wins. With no dialog, `focus.detach` runs and lands on sidebar.                    |
| `ctrl+c`         | copy selection vs double-tap quit       | Selection-aware. With text selected → copy via OSC52 + clear. Else first press arms a 1.5s quit window; second press in window = quit. Both behaviours live in `useKobeKeybindings`. `cmd+c` is a synonym for terminals that forward Cmd-chords (Kitty, Ghostty, iTerm2 with "Send Modifier Keys") so the chord doesn't get silently swallowed there. |
| `tab`            | pane cycle vs textarea focus actions    | `useKobeKeybindings` no-ops `tab` when workspace has focus so the composer's own tab handling (slash completion, indent) wins.                                                      |
| `[` / `]`        | sidebar view switch vs files tab cycle  | Both pane-scoped (different scopes), so the focused pane wins.                                                                                                                      |

## Adding a new binding — checklist

1. Decide the flavour (global/modifier vs pane-scoped/letter).
2. Add the row to `KobeKeymap`. Set `id`, `scope`, `keys`, `description`, optional `hint`, optional `category`.
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

### Pane focus chord — why `ctrl+hjkl`, not `ctrl+1..4`

We iterated through three candidates before landing on `ctrl+hjkl`. Recording the journey here so the next agent (or Jackson) doesn't
re-derive it.

1. **`ctrl+1..4`** — first attempt, mirrors VSCode/iTerm pane focus muscle memory.
   - **Conflict 1** (resolved): `chat.tab.pick` was registered on the same chords. Moved chat tab navigation to `ctrl+]` / `ctrl+[`
     cycle so pane focus has hard precedence.
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
