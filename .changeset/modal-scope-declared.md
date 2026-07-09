---
"@sma1lboy/kobe": patch
---

Modal keybinding precedence is now declared data, not a React effect-order accident.

The dialog barrier and dialog-body bindings used to resolve their precedence by which effect happened to commit first (sibling tree order) — documented only in a comment and pinned by no test. Registrations now carry an explicit modal scope (`modalOwner` on the barrier, membership stamped via `ModalScopeContext`), and a pure `insertRegistration` slots the barrier below its members under either registration order; dispatch itself is unchanged. Workspace-host dialog/page gating is consolidated into named, framework-free predicates (`workspacePagesClosed` / `settingsCloseKeysEnabled`) with unit tests, including the negative case (open dialog disables workspace chords) and the deliberate settings-close exemption. No chords added, moved, or rebound.
