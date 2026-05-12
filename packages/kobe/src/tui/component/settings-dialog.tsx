/**
 * Settings dialog — two-column layout with a left sidebar (sections)
 * and a right pane (the active section's content).
 *
 * Sections (v1):
 *   - General — placeholder. Real settings land here as we accumulate
 *     things worth toggling (theme, model default, default permission
 *     mode, etc.).
 *   - Dev    — affordances for development / debugging only. Currently
 *     hosts a "Reset UI state" button that wipes the KV store
 *     (`~/.config/kobe/state.json`) AND the task index
 *     (`~/.kobe/tasks.json`), then quits kobe so the user relaunches
 *     into a fresh in-memory state. Without exit, the persistence
 *     effects in app.tsx silently repopulate state.json from live
 *     Solid signals on the next change (KOB-12). Worktrees on disk
 *     are deliberately NOT touched — the branches still hold the
 *     user's work; they can clean up manually if they want.
 *
 * Bindings inside the dialog:
 *   - `↑` / `↓` — navigate the section sidebar.
 *   - `tab`     — same as `↓` (cycles).
 *   - `enter`   — activate the focused button in the section content.
 *   - `esc`     — close (handled by the dialog stack).
 */

import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator"
import type { KobeOrchestrator } from "../../client/remote-orchestrator"
import {
  type ClaudeAccount,
  type CodexAccount,
  type EngineAccountStatus,
  detectClaudeAccount,
  detectCodexAccount,
} from "../../engine/account-detect"
import { homeDir } from "../../env"
import type { KVContext } from "../context/kv"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

const FOCUS_ACCENT_LABEL: Record<FocusAccentSlot, string> = {
  primary: "Primary (brand accent)",
  success: "Success (legacy green)",
  info: "Info (cool blue)",
}

type SectionId = "general" | "accounts" | "dev"

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "dev", label: "Dev" },
]

export type SettingsDialogProps = {
  kv: KVContext
  /**
   * The active orchestrator. Used to expose the "Restart backend" Dev
   * button only when we're attached to a daemon (RemoteOrchestrator).
   * In KOBE_TEST_ENGINE / KOBE_NO_DAEMON modes the orchestrator runs
   * in-process and there is no daemon to restart — the row is hidden.
   */
  orchestrator?: KobeOrchestrator
  onClose: () => void
}

export function SettingsDialog(props: SettingsDialogProps) {
  const dialog = useDialog()
  const themeCtx = useTheme()
  const renderer = useRenderer()
  const { theme } = themeCtx
  // Two-level navigation:
  //   - `level === "sidebar"` — left column owns the cursor; j/k cycles
  //     section, l/right enters the body, enter just commits the
  //     section pick (already auto-applied).
  //   - `level === "body"` — right column owns the cursor; j/k cycles
  //     rows inside the active section, h/left pops back to the sidebar.
  // Single bodyRow signal indexes whichever section is active. The
  // body-row count is section-dependent so wrap math is computed per
  // section.
  const [level, setLevel] = createSignal<"sidebar" | "body">("sidebar")
  const [section, setSection] = createSignal<SectionId>("general")
  const [cursor, setCursor] = createSignal(0)
  const [bodyRow, setBodyRow] = createSignal(0)

  // Theme picker state — separate cursor from section sidebar's. Defaults
  // to the currently-active theme so an immediate enter is a no-op rather
  // than a surprise switch.
  const themeNames = createMemo<readonly string[]>(() => themeCtx.all().slice().sort())
  const [themeCursor, setThemeCursor] = createSignal(
    Math.max(
      0,
      themeNames().findIndex((n) => n === themeCtx.selected),
    ),
  )

  // True when we're attached to a daemon — controls whether the
  // "Restart backend" Dev row is offered. In-process mode has no
  // daemon to restart, so we omit the row entirely rather than
  // showing a disabled affordance.
  const hasDaemon = props.orchestrator instanceof RemoteOrchestrator

  // Account detection state. Read-only — we just surface what `claude`
  // and `codex` already wrote to disk. Runs async on mount so opening
  // the dialog never blocks on fs I/O; until results land we render a
  // muted "Checking…" placeholder. Future login flows hook in here.
  const [claudeStatus, setClaudeStatus] = createSignal<EngineAccountStatus<ClaudeAccount> | null>(null)
  const [codexStatus, setCodexStatus] = createSignal<EngineAccountStatus<CodexAccount> | null>(null)
  onMount(() => {
    void detectClaudeAccount()
      .then(setClaudeStatus)
      .catch((err: unknown) => {
        // Unexpected: detection swallows expected errors internally
        // and surfaces them via accountError. Anything that lands here
        // is a programmer error worth keeping visible in the logs.
        // eslint-disable-next-line no-console
        console.error("kobe: detectClaudeAccount threw:", err)
        setClaudeStatus({ binary: { found: false, error: String(err) }, account: { kind: "none" } })
      })
    void detectCodexAccount()
      .then(setCodexStatus)
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("kobe: detectCodexAccount threw:", err)
        setCodexStatus({ binary: { found: false, error: String(err) }, account: { kind: "none" } })
      })
  })
  // How many rows the current section's body has. General =
  //   N themes
  //   + 1 transparent-bg toggle
  //   + M focus-accent slots (one row per FOCUS_ACCENT_SLOTS entry).
  // Dev = reset button (+ optional restart-backend row when attached
  // to a daemon). The wrap-around math in moveCursor uses this to
  // clamp/cycle.
  function devRowCount(): number {
    return hasDaemon ? 2 : 1
  }
  function bodyRowCount(): number {
    if (section() === "general") return themeNames().length + 1 + FOCUS_ACCENT_SLOTS.length + 2
    if (section() === "dev") return devRowCount()
    // Accounts is read-only — no row-level navigation. j/k inside the
    // body is a no-op there, and l/right is harmless because there's
    // nothing to highlight.
    if (section() === "accounts") return 0
    return 0
  }
  // Map bodyRow to the underlying selection within the General section.
  // 0..N-1                                       → theme at that index
  // N                                            → transparent-bg toggle
  // N+1..N+FOCUS_ACCENT_SLOTS.length             → focus-accent slot picker
  // N+1+FOCUS_ACCENT_SLOTS.length                → notifications: toast toggle
  // N+2+FOCUS_ACCENT_SLOTS.length                → notifications: sound toggle
  function isTransparentRow(): boolean {
    return section() === "general" && bodyRow() === themeNames().length
  }
  function focusAccentRowIndex(): number | null {
    if (section() !== "general") return null
    const offset = themeNames().length + 1
    const i = bodyRow() - offset
    if (i < 0 || i >= FOCUS_ACCENT_SLOTS.length) return null
    return i
  }
  function toastRowIndex(): number {
    return themeNames().length + 1 + FOCUS_ACCENT_SLOTS.length
  }
  function soundRowIndex(): number {
    return toastRowIndex() + 1
  }
  function isToastRow(): boolean {
    return section() === "general" && bodyRow() === toastRowIndex()
  }
  function isSoundRow(): boolean {
    return section() === "general" && bodyRow() === soundRowIndex()
  }
  // Read through the reactive KV store so the toggle's `[x]/[ ]` label
  // re-renders when toggled. Defaults match the contract in
  // `notifications.tsx` — both on for first-launch users.
  function toastEnabled(): boolean {
    return (props.kv.get("notifications.toast.enabled", true) as boolean) !== false
  }
  function soundEnabled(): boolean {
    return (props.kv.get("notifications.sound.enabled", true) as boolean) !== false
  }
  function toggleToast(): void {
    props.kv.set("notifications.toast.enabled", !toastEnabled())
  }
  function toggleSound(): void {
    props.kv.set("notifications.sound.enabled", !soundEnabled())
  }

  function moveCursor(delta: number): void {
    if (level() === "sidebar") {
      const next = (cursor() + delta + SECTIONS.length) % SECTIONS.length
      setCursor(next)
      const nextSection = SECTIONS[next]
      if (nextSection) {
        setSection(nextSection.id)
        setBodyRow(0)
      }
      return
    }
    // Body level — j/k navigate rows.
    const len = bodyRowCount()
    if (len === 0) return
    const next = (bodyRow() + delta + len) % len
    setBodyRow(next)
    // Mirror the bodyRow into themeCursor so the theme list highlight
    // tracks j/k naturally.
    if (section() === "general" && next < themeNames().length) setThemeCursor(next)
  }

  function switchSection(id: SectionId): void {
    setSection(id)
    setCursor(SECTIONS.findIndex((s) => s.id === id))
    setBodyRow(0)
  }

  // Confirm before wiping kobe-owned state — the user explicitly asked
  // for it but it's still destructive (drops persisted layout, the
  // task list, etc.) and a stray enter on the row shouldn't blow it
  // away.
  //
  // Reset is "wipe + relaunch" rather than "wipe + snap defaults in
  // place": kv.clear() only resets the on-disk KV store, not the live
  // Solid signals (selectedId, pane widths, themeCtx's internal store,
  // tabsByTask, etc.) that get persisted into KV by the createEffect
  // batch in app.tsx. Without exit, those effects refire on the next
  // signal change and silently repopulate state.json. Restarting kobe
  // is the simplest way to drop every in-memory cache to defaults
  // without inventing a fragile per-signal reset registry. See KOB-12.
  //
  // Scope of "wipe":
  //   ✓ ~/.config/kobe/state.json — KV (theme, pane sizes, tab state).
  //   ✓ ~/.kobe/tasks.json — task index. Working session and Archive
  //     lists are visible UI state, so they have to clear too;
  //     otherwise the user opens reset, restarts, and the lists are
  //     unchanged. TaskIndexStore.load handles ENOENT cleanly.
  //   ✗ Worktree directories on disk — Jackson explicitly excluded
  //     these. The user can recover work from the branches manually.
  //   ✗ Claude Code session JSONLs in ~/.claude/projects/ — those are
  //     Claude Code's own data, not kobe-owned. Out of scope.
  //   ✗ User-installed themes in ~/.kobe/themes/ — user content, not
  //     auto-deletable.
  async function confirmReset(): Promise<void> {
    const ok = await DialogConfirm.show(
      dialog,
      "Reset UI state?",
      "Wipes ~/.config/kobe/state.json and ~/.kobe/tasks.json, then quits kobe — relaunch for a fresh start with empty Working session / Archive lists. Worktrees on disk and Claude Code session history are NOT touched.",
      "cancel",
    )
    if (ok !== true) return
    props.kv.clear()
    try {
      unlinkSync(join(homeDir(), ".kobe", "tasks.json"))
    } catch (err) {
      // ENOENT just means the index was never created (first-launch
      // reset, hermetic test boot). Anything else is worth surfacing
      // for the user before we exit.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.error("kobe: failed to delete tasks.json during reset:", err)
      }
    }
    // Tear down the renderer first so the alt-screen exit / mouse
    // tracking disable sequences flush before process.exit blocks
    // Node — same pattern as the global `app.quit` handler.
    try {
      renderer?.destroy()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("kobe: renderer.destroy() failed during reset:", err)
    }
    process.stderr.write("kobe: UI state reset. Relaunch kobe to start fresh.\n")
    process.exit(0)
  }

  /**
   * Stop the kobed daemon and quit kobe. The next relaunch will hit
   * the daemon-absent branch of `connectOrStartDaemon` and spawn a
   * fresh `kobed` from disk, picking up whatever edits the developer
   * just made to daemon/orchestrator/engine code (Bun reads modules
   * once at boot — there's no hot-reload, so a stale daemon silently
   * masks fixes until restart).
   *
   * Multi-attach caveat: this drops the socket for EVERY attached
   * TUI, not just this one. The confirm copy warns about it. Other
   * windows will see their wire close and either spin or no-op until
   * they're also relaunched.
   */
  async function confirmRestartDaemon(): Promise<void> {
    const orch = props.orchestrator
    if (!(orch instanceof RemoteOrchestrator)) return
    const ok = await DialogConfirm.show(
      dialog,
      "Restart backend?",
      "Stops the kobed daemon and quits this kobe window. Relaunch to spawn a fresh daemon with the latest code. Other attached kobe windows will lose their daemon connection too.",
      "cancel",
    )
    if (ok !== true) return
    try {
      await orch.stopDaemon()
    } catch (err) {
      // daemon.stop closes the socket as part of its work; the
      // request may reject with "daemon connection closed" before the
      // response frame arrives. That's the success path — swallow.
      // eslint-disable-next-line no-console
      console.error("kobe: daemon.stop returned:", err)
    }
    try {
      renderer?.destroy()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("kobe: renderer.destroy() failed during daemon restart:", err)
    }
    process.stderr.write("kobe: daemon stopped. Relaunch kobe to start fresh.\n")
    process.exit(0)
  }

  useBindings(() => ({
    bindings: [
      // Vertical nav — j/k or arrows. Cycles inside whichever level
      // owns the cursor. `tab` mirrors `down` so users with keymap
      // muscle memory from the new-task dialog still cycle.
      { key: "down", cmd: () => moveCursor(1) },
      { key: "up", cmd: () => moveCursor(-1) },
      { key: "j", cmd: () => moveCursor(1) },
      { key: "k", cmd: () => moveCursor(-1) },
      { key: "tab", cmd: () => moveCursor(1) },
      // Horizontal nav — l/right enters the section body, h/left pops
      // back to the sidebar. Lets the user reach the transparent-bg
      // toggle (and any future body rows) with pure keyboard nav,
      // and gives a one-keystroke path back to "switch section."
      {
        key: "right",
        cmd: () => {
          if (level() === "sidebar" && bodyRowCount() > 0) {
            setLevel("body")
            setBodyRow(0)
            if (section() === "general") setThemeCursor(0)
          }
        },
      },
      {
        key: "l",
        cmd: () => {
          if (level() === "sidebar" && bodyRowCount() > 0) {
            setLevel("body")
            setBodyRow(0)
            if (section() === "general") setThemeCursor(0)
          }
        },
      },
      {
        key: "left",
        cmd: () => setLevel("sidebar"),
      },
      {
        key: "h",
        cmd: () => setLevel("sidebar"),
      },
      // `enter` activates whatever the current cursor points at.
      //   - Sidebar level → body level on the same section.
      //   - Body level + General theme row → apply that theme.
      //   - Body level + General transparent row → toggle.
      //   - Body level + Dev → reset.
      {
        key: "return",
        cmd: () => {
          if (level() === "sidebar") {
            // Drill into the body of the highlighted section.
            if (bodyRowCount() > 0) {
              setLevel("body")
              setBodyRow(0)
              if (section() === "general") setThemeCursor(0)
            }
            return
          }
          if (section() === "general") {
            if (isTransparentRow()) {
              themeCtx.setTransparentBackground(!themeCtx.transparentBackground)
              return
            }
            const focusIdx = focusAccentRowIndex()
            if (focusIdx !== null) {
              const slot = FOCUS_ACCENT_SLOTS[focusIdx]
              if (slot) themeCtx.setFocusAccent(slot)
              return
            }
            if (isToastRow()) {
              toggleToast()
              return
            }
            if (isSoundRow()) {
              toggleSound()
              return
            }
            const name = themeNames()[bodyRow()]
            if (name) themeCtx.set(name)
            return
          }
          if (section() === "dev") {
            if (bodyRow() === 0) void confirmReset()
            else if (hasDaemon && bodyRow() === 1) void confirmRestartDaemon()
          }
        },
      },
      // `t` is still a quick toggle for transparent-bg from anywhere
      // inside the dialog — earlier flow had it as the only way to
      // reach the toggle, now it's a shortcut.
      {
        key: "t",
        cmd: () => themeCtx.setTransparentBackground(!themeCtx.transparentBackground),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Settings
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          esc
        </text>
      </box>
      {/* Two-column body: left section list, right active-section content. */}
      <box flexDirection="row" gap={2}>
        {/* Section sidebar */}
        <box flexDirection="column" flexShrink={0} width={14} gap={0}>
          <For each={SECTIONS}>
            {(s, i) => {
              // Highlight color tracks "is this the active section."
              // Strong (primary bg) when the SIDEBAR LEVEL has the
              // cursor — i.e. j/k will move section. Soft (accent text)
              // when the body level owns the cursor — the section is
              // still selected but j/k is navigating body rows now.
              const isSection = () => i() === cursor()
              const isSidebarFocused = () => isSection() && level() === "sidebar"
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isSidebarFocused() ? theme.primary : undefined}
                  onMouseUp={() => {
                    switchSection(s.id)
                    setLevel("sidebar")
                  }}
                >
                  <text
                    fg={isSidebarFocused() ? theme.selectedListItemText : isSection() ? theme.accent : theme.textMuted}
                    attributes={isSection() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {s.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        {/* Section content */}
        <box flexGrow={1} flexShrink={1} flexDirection="column" gap={1}>
          <Show when={section() === "general"}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Theme
              </text>
              <text fg={theme.textMuted}>l to enter list · j/k to highlight · enter to apply</text>
              <box flexDirection="column" gap={0}>
                <For each={themeNames()}>
                  {(name, i) => {
                    // Highlight only when body-level + this row is the
                    // current bodyRow. Sidebar-level shouldn't paint a
                    // theme cursor — that visual conflict was confusing.
                    const isCursor = () => level() === "body" && bodyRow() === i()
                    const isSelected = () => name === themeCtx.selected
                    return (
                      <box
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={isCursor() ? theme.primary : undefined}
                        onMouseUp={() => {
                          setLevel("body")
                          setBodyRow(i())
                          setThemeCursor(i())
                          themeCtx.set(name)
                        }}
                      >
                        <text
                          fg={isCursor() ? theme.selectedListItemText : isSelected() ? theme.accent : theme.text}
                          attributes={isCursor() || isSelected() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                        >
                          {isSelected() ? "● " : "  "}
                          {name}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
              {/* Transparent-bg toggle — orthogonal to theme. Lets the host
                  terminal's bg / image / opacity show through while the
                  active palette controls every other token. Toggle with
                  `t`. */}
              <box flexDirection="column" gap={0} paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Transparent background
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  Drops the renderer's bg fill so the host terminal shows through. `t` toggles.
                </text>
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isTransparentRow() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setLevel("body")
                    setBodyRow(themeNames().length)
                    themeCtx.setTransparentBackground(!themeCtx.transparentBackground)
                  }}
                >
                  <text
                    fg={
                      isTransparentRow()
                        ? theme.selectedListItemText
                        : themeCtx.transparentBackground
                          ? theme.accent
                          : theme.textMuted
                    }
                    attributes={TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {themeCtx.transparentBackground ? "[x] on" : "[ ] off"}
                  </text>
                </box>
              </box>
              {/* Focus accent — picks which theme slot drives the focused
                  pane indicator (header title, ▌ marker, sidebar header,
                  resizable-edge focus, terminal border). Default
                  primary unifies the focus signal with the brand hue;
                  success keeps the older opencode-style green. */}
              <box flexDirection="column" gap={0} paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Focus accent
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  Color of focused pane title, ▌ marker, and split borders.
                </text>
                <For each={FOCUS_ACCENT_SLOTS}>
                  {(slot, i) => {
                    const rowIndex = () => themeNames().length + 1 + i()
                    const isCursor = () => level() === "body" && bodyRow() === rowIndex()
                    const isSelected = () => themeCtx.focusAccent === slot
                    return (
                      <box
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={isCursor() ? theme.primary : undefined}
                        onMouseUp={() => {
                          setLevel("body")
                          setBodyRow(rowIndex())
                          themeCtx.setFocusAccent(slot)
                        }}
                      >
                        <text
                          fg={isCursor() ? theme.selectedListItemText : isSelected() ? theme.focusAccent : theme.text}
                          attributes={isCursor() || isSelected() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                        >
                          {isSelected() ? "● " : "  "}
                          {FOCUS_ACCENT_LABEL[slot]}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
              {/* Notifications — two independent toggles. Toast = the
                  visual overlay; Sound = terminal BEL + bundled chime.
                  The tab-chip unread dot is always on (passive marker;
                  turning notifications off shouldn't lose the "you
                  missed something" signal). */}
              <box flexDirection="column" gap={0} paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Notifications
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  Fired when a background chat tab finishes or pauses on an approval. Toast = bottom-right popup; Sound
                  = terminal bell + chime. Tab-chip unread dot is always on.
                </text>
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isToastRow() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setLevel("body")
                    setBodyRow(toastRowIndex())
                    toggleToast()
                  }}
                >
                  <text
                    fg={isToastRow() ? theme.selectedListItemText : toastEnabled() ? theme.accent : theme.textMuted}
                    attributes={TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {toastEnabled() ? "[x]" : "[ ]"} Toast
                  </text>
                </box>
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isSoundRow() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setLevel("body")
                    setBodyRow(soundRowIndex())
                    toggleSound()
                  }}
                >
                  <text
                    fg={isSoundRow() ? theme.selectedListItemText : soundEnabled() ? theme.accent : theme.textMuted}
                    attributes={TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {soundEnabled() ? "[x]" : "[ ]"} Sound
                  </text>
                </box>
              </box>
            </box>
          </Show>
          <Show when={section() === "accounts"}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Accounts
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                Read-only view of locally-detected engine accounts. Login flows land here later.
              </text>
              {/* claude-code */}
              <box flexDirection="column" gap={0}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  claude-code
                </text>
                <Show when={claudeStatus() === null}>
                  <text fg={theme.textMuted}>Checking…</text>
                </Show>
                <Show when={claudeStatus()}>
                  {(s) => (
                    <box flexDirection="column" gap={0}>
                      <text fg={s().binary.found ? theme.textMuted : theme.warning} wrapMode="word">
                        {s().binary.found
                          ? `Binary: ${(s().binary as { path: string }).path}`
                          : `Binary: ${(s().binary as { error: string }).error}`}
                      </text>
                      {(() => {
                        const a = s().account
                        if (a.kind === "oauth") {
                          const tail = [a.organization, a.billingType].filter((x): x is string => !!x).join(" · ")
                          return (
                            <text fg={theme.success} wrapMode="word">
                              {`● Logged in: ${a.email}${tail ? ` (${tail})` : ""}`}
                            </text>
                          )
                        }
                        return <text fg={theme.textMuted}>○ Not logged in</text>
                      })()}
                      <Show when={s().accountError}>
                        {(err) => (
                          <text fg={theme.warning} wrapMode="word">
                            {`! ${err()}`}
                          </text>
                        )}
                      </Show>
                    </box>
                  )}
                </Show>
              </box>
              {/* codex */}
              <box flexDirection="column" gap={0}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  codex
                </text>
                <Show when={codexStatus() === null}>
                  <text fg={theme.textMuted}>Checking…</text>
                </Show>
                <Show when={codexStatus()}>
                  {(s) => (
                    <box flexDirection="column" gap={0}>
                      <text fg={s().binary.found ? theme.textMuted : theme.warning} wrapMode="word">
                        {s().binary.found
                          ? `Binary: ${(s().binary as { path: string }).path}`
                          : `Binary: ${(s().binary as { error: string }).error}`}
                      </text>
                      {(() => {
                        const a = s().account
                        if (a.kind === "chatgpt") {
                          return (
                            <text fg={theme.success} wrapMode="word">
                              {`● ChatGPT login: ${a.email}${a.plan ? ` (${a.plan})` : ""}`}
                            </text>
                          )
                        }
                        if (a.kind === "apikey") {
                          return <text fg={theme.success}>● API key configured</text>
                        }
                        return <text fg={theme.textMuted}>○ Not logged in</text>
                      })()}
                      <Show when={s().accountError}>
                        {(err) => (
                          <text fg={theme.warning} wrapMode="word">
                            {`! ${err()}`}
                          </text>
                        )}
                      </Show>
                    </box>
                  )}
                </Show>
              </box>
            </box>
          </Show>
          <Show when={section() === "dev"}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Reset UI state
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                Clears ~/.config/kobe/state.json and ~/.kobe/tasks.json, then quits kobe — relaunch to start fresh.
                Working session / Archive lists, pane sizes, theme, model picks all reset. Worktrees on disk and Claude
                Code session history are not touched.
              </text>
              {/* Same row-cursor pattern as General's body rows — when
                  the body level owns the cursor, this row paints in
                  the primary color so the user sees what `enter`
                  would activate. Click also drills focus into the
                  body level, mirroring the General rows' behaviour. */}
              {(() => {
                const isCursor = () => level() === "body" && bodyRow() === 0
                return (
                  <box
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={isCursor() ? theme.primary : theme.backgroundElement}
                    onMouseUp={() => {
                      setLevel("body")
                      setBodyRow(0)
                      void confirmReset()
                    }}
                  >
                    <text fg={isCursor() ? theme.selectedListItemText : theme.warning} attributes={TextAttributes.BOLD}>
                      [enter] Reset
                    </text>
                  </box>
                )
              })()}
              {/* Restart-backend row. Only rendered when the TUI is
                  attached to a daemon — in-process mode (KOBE_TEST_ENGINE
                  / KOBE_NO_DAEMON) has nothing to restart. Sits at
                  bodyRow=1 so j/k cycles Reset (0) ↔ Restart (1). */}
              <Show when={hasDaemon}>
                <box flexDirection="column" gap={0} paddingTop={1}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    Restart backend
                  </text>
                  <text fg={theme.textMuted} wrapMode="word">
                    Stops the kobed daemon and quits this kobe window so the next launch spawns a fresh daemon — picks
                    up daemon / orchestrator / engine edits without a process kill. Other attached kobe windows will
                    lose their connection too.
                  </text>
                  {(() => {
                    const isCursor = () => level() === "body" && bodyRow() === 1
                    return (
                      <box
                        flexDirection="row"
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={isCursor() ? theme.primary : theme.backgroundElement}
                        onMouseUp={() => {
                          setLevel("body")
                          setBodyRow(1)
                          void confirmRestartDaemon()
                        }}
                      >
                        <text
                          fg={isCursor() ? theme.selectedListItemText : theme.accent}
                          attributes={TextAttributes.BOLD}
                        >
                          [enter] Restart
                        </text>
                      </box>
                    )
                  })()}
                </box>
              </Show>
            </box>
          </Show>
        </box>
      </box>
      <box paddingTop={0}>
        <text fg={theme.textMuted}>j/k pick · h/l switch level · enter activate · esc close</text>
      </box>
    </box>
  )
}

SettingsDialog.show = (dialog: DialogContext, kv: KVContext, orchestrator?: KobeOrchestrator): Promise<void> => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <SettingsDialog kv={kv} orchestrator={orchestrator} onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
