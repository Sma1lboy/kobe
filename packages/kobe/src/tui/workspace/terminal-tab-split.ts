/**
 * Split-tree + naming policy for a terminal tab — the terminal-flavored
 * layer over the content-agnostic `split-core.ts` tree, split out of
 * `terminal-tabs-core.ts` (the tab-list transitions) purely for the
 * 500-line file-size cap. Owns the persisted leaf payload shape
 * ({@link PersistedSplit}), the collapse/is-split/has-engine predicates,
 * leaf PTY keying, leaf display naming, and the tab-level display naming
 * ({@link tabTitle} — framework-free so both the strip and non-render
 * callers share one rule). Never imports `TabsState`; the one tab-shape
 * dependency is the type-only {@link TerminalTab} (erased at runtime, so
 * no cycle with `terminal-tabs-core`).
 */

import type { VendorId } from "@/types/vendor"
import {
  engineEntry,
  engineSessionIdFromTitle,
  engineStatusPrefixes,
  stripEngineStatusPrefix,
} from "../../engine/registry"
import { t } from "../i18n"
import { pathLeaf } from "../lib/path-helpers"
import { type SplitState, leaves } from "./split-core"
import type { TerminalTab } from "./terminal-tabs-core"

/**
 * A tab's frozen split layout — the content-agnostic tree (`split-core`)
 * with terminal-flavored leaf payloads: `null` = the tab's own engine
 * command (only `leaf-1`), an argv = a split-created shell. JSON-safe, so
 * it rides the persisted tab straight into state.json.
 */
export type PersistedSplit = SplitState<readonly string[] | null>

/**
 * Whether a tab still runs its own engine leaf (`leaf-1`) — false once
 * you've closed it inside a split and only split-created shells survive
 * (57e3a20a). Unsplit (no tree) always counts as having it. Callers that
 * treat an engine tab as having live turn activity (the turn-poll loop,
 * the tab-strip's turn chip) must gate on this too, or a closed engine
 * leaf leaves a stale poll flapping against its released PTY.
 */
export function hasEngineLeaf(tree: PersistedSplit | null | undefined): boolean {
  return !tree || leaves(tree.root).some((l) => l.id === "leaf-1")
}

/**
 * Whether a tab's frozen layout is ACTUALLY split (>1 leaf). Gates the
 * ctrl+w / F2 chord fall-through between `TerminalTabs` and
 * `TerminalSplit`: while split, the tab-level close/rename bindings
 * disable so the chords reach the leaf-level ones, and vice versa. A
 * single surviving non-leaf-1 shell is NOT split — tab-level chords apply.
 */
export function isTabSplit(tree: PersistedSplit | null | undefined): boolean {
  return tree ? leaves(tree.root).length > 1 : false
}

/**
 * Collapse rule for a structural split edit: a tree whose SOLE survivor
 * is `leaf-1` (the tab's own engine at the tab key) folds back to `null`
 * — the unsplit fast path. A sole surviving SHELL leaf must KEEP the
 * tree: the fast path would respawn the engine (`props.command` at the
 * tab key) over it. Doubles as the render predicate — a non-null result
 * means the tab renders via the tree, not the single-engine fast path.
 */
export function collapseSplit(next: PersistedSplit): PersistedSplit | null {
  const ls = leaves(next.root)
  return ls.length === 1 && ls[0]?.id === "leaf-1" ? null : next
}

/**
 * Registry key for one split leaf's PTY inside a tab (`TerminalSplit.tsx`
 * over the content-agnostic `split-core.ts`). `leaf-1` maps to the TAB
 * key itself so the PTY that existed before the first split is reused,
 * not respawned; later leaves namespace under it.
 */
export function splitLeafPtyKey(tabKey: string, leafId: string): string {
  return leafId === "leaf-1" ? tabKey : `${tabKey}::${leafId}`
}

/**
 * Display names for a split tab's leaves, id → name (owner semantics
 * 2026-07-06: the TAB is the "group"; each leaf carries its OWN name).
 * Naming flow mirrors tabs: a manual rename (`leaf.title`) always wins.
 *
 * The ENGINE leaf (`null` content = the tab's own command) reads the
 * conversation's first-prompt title (`engineTitle` — the tab's own
 * title/autoTitle, the same string the group/tab label shows), falling back
 * to the command basename ("claude"/"codex") before the first prompt lands.
 * Split SHELL leaves read their live foreground-process title (`liveTitles`
 * — the OSC 0/2 window-title escape the shell/program sets, same mechanism
 * a real terminal tab uses: "zsh" idle, "vim"/"htop" once you run one),
 * falling back to the generic "shell" before any title has landed yet.
 * Same-named defaults get a reading-order occurrence suffix ("shell",
 * "shell 2") so two untitled shells stay tellable apart. Manual titles (F2
 * rename) always win and are never suffixed.
 */
/** Generic default name for a split-created shell leaf (a bare shell has no
 *  meaningful program name). Shared so the corner tag and a collapsed tab's
 *  label agree. */
export const SHELL_LEAF_NAME = "shell"

export function splitLeafNames(
  leafList: readonly { id: string; title?: string | null; content: readonly string[] | null }[],
  tabCommand: readonly string[],
  engineTitle?: string | null,
  liveTitles?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const basename = (argv: readonly string[] | null): string => {
    const head = (argv ?? tabCommand)[0] ?? ""
    const name = pathLeaf(head)
    return name.length > 0 ? name : "?"
  }
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const leaf of leafList) {
    if (leaf.title) {
      out.set(leaf.id, leaf.title)
      continue
    }
    // Engine leaf → first-prompt title, else its live foreground-process
    // title (a shell tab's leaf-1 runs zsh and can enter claude/vim — the
    // static command basename would freeze on "zsh"), else vendor basename;
    // split shell leaf → live title, else generic "shell". Both dedupe by
    // reading order.
    const name =
      leaf.content === null
        ? engineTitle || liveTitles?.get(leaf.id) || basename(leaf.content)
        : liveTitles?.get(leaf.id) || SHELL_LEAF_NAME
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    out.set(leaf.id, n === 1 ? name : `${name} ${n}`)
  }
  return out
}

/**
 * Default tab names are "$process $ordinal" (owner naming 2026-07-07):
 * a tab IS a terminal, so its name says what runs in it — "claude 3",
 * "shell 5", "vim 2" — never an opaque "tab N". `liveName` is the tab's
 * live foreground-process display name from `useTurnPolls().liveTitles`;
 * engine tabs don't need it (their process is known by construction),
 * callers without it (notifications) fall back to the static shell default.
 *
 * Plain (non-hook) helper — used by the strip render AND outside render
 * (rename dialog prefill, notification titles) — so it reads the
 * module-level `t()` rather than `useT()`.
 */
/**
 * First-prompt junk guard: a conversation whose opening prompt was a menu
 * answer ("1", "y", "ok") or bare punctuation must not name the tab — treat
 * it as absent so the vendor default ("claude 2") applies. Display-side on
 * purpose: already-persisted junk autoTitles heal without a migration.
 */
export function meaningfulAutoTitle(autoTitle: string | null | undefined): string | null {
  const trimmed = (autoTitle ?? "").trim()
  if (trimmed.length < 3) return null
  if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmed)) return null
  return trimmed
}

/**
 * The recorded title as a stable NAME, or null when it is not one.
 *
 * Strips the engine's status decoration (idempotent — a title recorded after
 * the entry-point fix passes through, an older snapshot heals on display),
 * then rejects a recording that was ONLY decoration. `stripEngineStatusPrefix`
 * keeps such a title on purpose — a session genuinely named "✳" owns that
 * name — but in the tree a lone glyph is not a label, so the caller falls
 * through to the first-prompt summary or the vendor default instead.
 */
function stableRecordedTitle(raw: string | null | undefined, vendor: VendorId): string | null {
  const recorded = raw?.trim()
  if (!recorded) return null
  const cleaned = stripEngineStatusPrefix(recorded, vendor)
  if (engineSessionIdFromTitle(vendor, cleaned)) return null
  // Unchanged AND made only of this engine's glyphs = decoration, not a name.
  if (cleaned === recorded && isEngineDecoration(recorded, vendor)) return null
  return cleaned || null
}

/** True when every character of `text` is one of the engine's status glyphs. */
function isEngineDecoration(text: string, vendor: VendorId): boolean {
  const glyphs = new Set(engineStatusPrefixes(vendor))
  return [...text].every((ch) => ch.trim().length === 0 || glyphs.has(ch))
}

/**
 * A tab's name for a surface that shows kobe's OWN state glyph beside it —
 * the sidebar tree.
 *
 * This used to DISCARD the recorded `lastTitle` for a status-owning engine
 * and fall through to the first-prompt summary or the vendor default,
 * because that recording was the engine's whole status line — `⠐ 利用自进化…`
 * still spinning on a row whose glyph said idle. Since the status prefix is
 * stripped where the title enters the app (`stripEngineStatusPrefix`), what
 * is recorded is the NAME, and throwing it away left every tree row reading
 * "claude 1" while the tab strip showed the real conversation title (owner
 * report 2026-08-10).
 *
 * So the rule is now: strip the decoration, keep the name. Titles recorded
 * BEFORE that fix still carry their prefix, so it is stripped again here —
 * display-side, so old snapshots heal without a migration (same approach as
 * `meaningfulAutoTitle`). A manual rename still wins: that is the user's
 * name, not the engine's.
 *
 * `liveTitle` is the pty host's CURRENT OSC title for this tab's session,
 * when the caller has one. `lastTitle` is a recording written only by the
 * mounted `TerminalTabs`, i.e. only for the selected task — so on every
 * other row it froze at whatever it said when you last clicked in, beside a
 * state glyph the daemon keeps live. Passing the live title in here (rather
 * than painting it directly) is what keeps it subject to the whole rule
 * below: the same status-prefix strip, the same decoration-only rejection,
 * and the same manual-rename precedence. Absent → the recorded title, which
 * is also the flash guard the live probe's ~2s gap needs.
 */
export function tabTitleStable(
  tab: TerminalTab,
  taskVendor: VendorId,
  liveVendor?: VendorId | null,
  liveTitle?: string | null,
): string {
  // `liveVendor` is tri-state: a vendor = that engine runs in the tab NOW;
  // null = the probe CONFIRMED no engine (a ctrl+C'd tab sitting at its
  // shell prompt); undefined = the probe can't answer, fall back to the pin.
  // A confirmed-dead engine tab is a shell: neither its frozen status line
  // nor its creation pin ("codex N") may keep naming it.
  if (liveVendor === null && tab.kind === "engine") {
    return tabTitle({ ...tab, kind: "command", lastTitle: null } as TerminalTab, taskVendor)
  }
  // Resolution order for "whose title is this": the live probe, then the
  // tab's own RECORDED identity, then an engine tab's creation pin. The
  // recorded step matters for the flash (owner report 2026-08-10): clicking
  // a tab writes `lastTitle` immediately, but the live probe is a ~2s ps
  // walk, so for one render there is no live vendor — and without the
  // recorded fallback this dropped to the raw-title branch below and flashed
  // the engine's own status line ("⠐ Refactoring the parser") before
  // settling back to "claude 1".
  const vendor =
    liveVendor ?? tab.liveVendor ?? (tab.kind === "engine" ? (tab.vendor ?? taskVendor) : undefined) ?? undefined
  // Cleaning the recorded title is NOT gated on `ownsStatus`: a status glyph
  // is not part of a name whoever wrote it, and the vendor kobe resolves is
  // often a user wrapper (`claudecpa` — a zsh function that ends up running
  // real claude) that declares nothing. Gating here left exactly those tabs
  // wearing `⠂ …`. What `ownsStatus` still decides is the fallback identity
  // below.
  // Live beats recorded — the recording is a snapshot of this same stream,
  // taken whenever the tab was last mounted. Falling back rather than
  // replacing keeps the flash guard above intact: a session the host has no
  // title for yet still shows what it was called.
  const source = liveTitle?.trim() || tab.lastTitle
  const named = vendor ? stableRecordedTitle(source, vendor) : (source ?? null)
  if (!vendor || engineEntry(vendor).terminalTitle?.ownsStatus !== true) {
    return tabTitle({ ...tab, lastTitle: named } as TerminalTab, taskVendor)
  }
  // Re-run the normal precedence with the recorded title CLEANED rather than
  // dropped: `stripEngineStatusPrefix` is idempotent, so a title recorded
  // after the entry-point fix passes through untouched while an older
  // snapshot (`⠂ Herdr…`) heals on display. An empty result means the
  // recording was nothing but decoration — fall through to the next rung
  // (first-prompt summary, then the vendor default) by clearing it.
  //
  // The RESOLVED vendor also replaces an engine tab's creation pin in that
  // fallback: a tab spawned as codex whose shell now runs claude must not
  // keep wearing "codex N" — the pin is history, the live process is the name.
  //
  // The vendor rides along for a COMMAND tab too (mirroring the demotion
  // branch above): a shell the user typed `claude` into is named by that
  // engine, not "shell N". `kind` only steers `tabTitle`'s final
  // vendor-default branch, so re-shaping it here is naming-only — no session
  // or resume story is implied (see terminal-tab-identity.ts).
  // `stripEngineStatusPrefix` deliberately returns a decoration-ONLY title
  // untouched (a session genuinely named "✳" keeps its name — see there).
  // In the tree that is not a name at all, so drop it and let the next rung
  // answer: `meaningfulAutoTitle` already applies the same "this is not a
  // label" judgement to first-prompt summaries.
  return tabTitle({ ...tab, kind: "engine", vendor, lastTitle: named } as TerminalTab, taskVendor)
}

export function tabTitle(tab: TerminalTab, taskVendor: VendorId, liveName?: string | null): string {
  // Manual rename always wins; a conversation's first-prompt title beats
  // the numbered default; a multi-leaf SPLIT tab is a "group N" (its
  // leaves carry the individual names — see splitLeafNames).
  if (tab.title) return tab.title
  const ls = tab.splitTree ? leaves(tab.splitTree.root) : []
  if (ls.length > 1) return t("terminal.tab.groupTitle", { n: tab.ordinal })
  // Collapsed to a single NON-engine leaf (you closed the engine leaf and
  // a shell survives) → that leaf's rename, else its live process name.
  const sole = ls.length === 1 ? ls[0] : undefined
  if (sole && sole.id !== "leaf-1") return sole.title ?? `${liveName ?? SHELL_LEAF_NAME} ${tab.ordinal}`
  // The RUNNING process names the tab first (liveName — the OSC title
  // stream, owner order 2026-07-09: rename > live process > first-prompt >
  // vendor default). The first-prompt autoTitle and vendor derivation are
  // only the pre-title fallback. Deriving from the task's CURRENT vendor
  // relabelled every inherit-mode tab the moment a new tab switched the
  // task engine, while their PTYs kept running the old one.
  const titleVendor =
    tab.liveVendor === null
      ? undefined
      : (tab.liveVendor ?? (tab.kind === "engine" ? (tab.vendor ?? taskVendor) : undefined))
  const isSessionIdentity = (value: string): boolean => {
    if (!titleVendor) return false
    const cleaned = stripEngineStatusPrefix(value.trim(), titleVendor)
    return engineSessionIdFromTitle(titleVendor, cleaned) !== null
  }
  if (liveName && !isSessionIdentity(liveName)) return `${liveName} ${tab.ordinal}`
  // No LIVE title here (a surface rendering a tab it doesn't host — the
  // Inbox), so fall back to the last live title this tab recorded. Without
  // it those surfaces drop straight to `autoTitle`, the FIRST prompt's
  // summary, and a tab that has long moved on still reads as its opening
  // question.
  if (tab.lastTitle && !isSessionIdentity(tab.lastTitle)) return `${tab.lastTitle} ${tab.ordinal}`
  const auto = meaningfulAutoTitle(tab.autoTitle)
  if (auto) return auto
  const name =
    tab.kind === "engine"
      ? (engineEntry(tab.vendor ?? taskVendor).defaultCommand[0] ?? SHELL_LEAF_NAME)
      : SHELL_LEAF_NAME
  return `${name} ${tab.ordinal}`
}

/**
 * True only when `tabTitle` is visibly rendering an engine-owned title.
 * Launch-path agnostic: `vendor` is the tab's resolved live process identity
 * (`useTurnPolls().turnVendors` — the same `turn-target.ts` rule that
 * attaches detectors), so a user-typed `claude` in a shell and a
 * kobe-launched engine tab get the exact same treatment. The label
 * comparison replaces structural kind/leaf checks: native status is visible
 * iff the rendered label IS the live title.
 */
export function visibleNativeStatus(
  tab: TerminalTab,
  taskVendor: VendorId,
  vendor: VendorId | undefined,
  liveName?: string | null,
): boolean {
  if (!vendor || !liveName) return false
  if (engineEntry(vendor).terminalTitle?.ownsStatus !== true) return false
  return tabTitle(tab, taskVendor, liveName) === `${liveName} ${tab.ordinal}`
}
