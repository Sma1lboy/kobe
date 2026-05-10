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
| 1       | Sidebar (TASKS) | `"sidebar"`   | `ctrl+1`    |
| 2       | Workspace (chat / files preview) | `"workspace"` | `ctrl+2`    |
| 3       | Files       | `"files"`     | `ctrl+3`    |
| 4       | Terminal    | `"terminal"`  | `ctrl+4`    |

`ctrl+1..4` is **global** (`scope: "global"`, id `focus.numeric`). It fires from any pane, including when the chat composer has the
keyboard. The only thing that suppresses it is an open dialog — every binding registration in `app.tsx` includes
`enabled: dialog.stack.length === 0` so dialog-internal keys (esc to dismiss, enter to confirm) win on the dialog stack.

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
| `alt+1..4`       | `focus.numeric` (global) — works without any terminal config | Pane focus uses `alt+digit` (Option+digit on macOS) instead of `ctrl+digit`. **Why not ctrl?** ctrl+digit needs CSI-u / kitty keyboard support; even with kobe's `useKittyKeyboard: {}` enabled, iTerm2 has a known quirk where ctrl+1 (and ctrl+9 / ctrl+0) silently fall through to a bare `1` byte while ctrl+2..8 emit CSI-u correctly. tmux without `extended-keys on` strips them all. alt+digit produces a stable `ESC <digit>` two-byte sequence that every terminal sends without protocol negotiation, so the chord works for everyone with no setup. |
| `esc`            | dialog dismiss vs `focus.detach`        | `DialogProvider` registers a higher-priority `escape` binding while a dialog is open; dialog pop wins. With no dialog, `focus.detach` runs and lands on sidebar.                    |
| `ctrl+c`         | copy selection vs double-tap quit       | Selection-aware. With text selected → copy via OSC52 + clear. Else first press arms a 1.5s quit window; second press in window = quit. Both behaviours live in `useKobeKeybindings`. |
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
