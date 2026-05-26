/**
 * The new-task dialog JSX shell.
 *
 * The dialog hosts two sibling sub-tabs sharing one frame:
 *
 *   1. **Existing** — pick an existing local repo path + base branch.
 *      Repo input is a unified free-text + smart dropdown that swaps
 *      between two surfaces based on what the user typed
 *      (see `pickerModeFor`):
 *        - saved mode (default, empty / short input): substring-filter
 *          the curated saved-repo list (cwd + /add-repo entries).
 *        - browse mode (user typed a path): directory drill-down.
 *      Branch picker augments the input so the user can arrow + enter
 *      rather than retype.
 *
 *   2. **New Repo** — clone a remote repo, then create a task on the
 *      clone. Fields: git URL, parent directory (with the same
 *      drill-down picker the existing tab uses), folder name (auto-
 *      derived from the URL, editable), base branch (defaults to
 *      "main"). The clone is spawned asynchronously and the dialog
 *      stays responsive while it runs.
 *
 * Tabs are switched with `Ctrl+[` / `Ctrl+]` while the dialog is open
 * — same bracket-pair pattern as chat-tab cycling and the
 * Working/Archives view-switcher. With only two tabs the chord pair
 * behaves as a toggle.
 *
 * Pure logic (field cycling, repo dedup, filtering, windowing,
 * validation, branch enumeration, URL parsing, clone spawn) lives in
 * `./state.ts` so it can be unit-tested without standing up the dialog
 * stack or opentui.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import {
  DEFAULT_BASE_REF,
  type DialogTab,
  type Field,
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  cloneRepo,
  computeRepoOptions,
  deriveFolderName,
  expandHome,
  filterBranches,
  filterRepos,
  filterSubdirs,
  findAvailableFolderName,
  firstFieldFor,
  getCurrentBranch,
  joinDrill,
  listLocalBranches,
  listSubdirs,
  nextDialogTab,
  nextField,
  pickerModeFor,
  resolveBaseRef,
  resolveCloneTarget,
  splitPathForDirSuggest,
  stripNewlines,
  validateCloneTarget,
  validateGitUrl,
  validateRepoPath,
  windowAround,
} from "./state"

export type NewTaskDialogProps = {
  onSubmit: (v: NewTaskInput) => void
  onCancel: () => void
  defaultRepo: string
  /**
   * User-curated repo list, persisted via `/add-repo`. Surfaced in
   * the unified picker's "saved" mode (the default when the input is
   * empty or doesn't look like a path). The current launch directory
   * (`defaultRepo`) is always prepended so the user can pick "where I
   * started kobe" without having to add it first.
   */
  savedRepos: readonly string[]
  /**
   * Default parent directory for the Clone tab — persisted across
   * dialog opens by the caller (kv `lastClonedRepoParent`). Empty
   * falls back to `~/` inside the dialog.
   */
  defaultCloneParent?: string
}

export function NewTaskDialogView(props: NewTaskDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Which sub-tab is currently visible. Switched via Ctrl+[ / Ctrl+].
  const [tab, setTab] = createSignal<DialogTab>("existing")

  // Dialog only asks for repo + branch on the existing tab. The first
  // prompt lives in the chat composer — orchestrator.runTask back-fills
  // the task title from it on first submit (see PLACEHOLDER_TASK_TITLE
  // in core.ts).
  const [field, setField] = createSignal<Field>("repo")
  const [repo, setRepo] = createSignal(props.defaultRepo)
  // Initial baseRef tracks the cwd's current branch (e.g. a worktree
  // forked from a feature branch should default to that branch, not
  // hardcoded "main"). Falls back to DEFAULT_BASE_REF when the path
  // isn't a repo or HEAD is detached.
  const [baseRef, setBaseRef] = createSignal(getCurrentBranch(expandHome(props.defaultRepo.trim())) ?? DEFAULT_BASE_REF)
  // True once the user has typed into the baseRef input. We stop
  // auto-syncing from the repo's current branch after that so a manual
  // override isn't overwritten when the user goes back to tweak the
  // repo path.
  const [baseRefTouched, setBaseRefTouched] = createSignal(false)

  // Clone-tab state. Folder name auto-derives from the URL until the
  // user manually edits it (`cloneFolderTouched`).
  const [cloneUrl, setCloneUrl] = createSignal("")
  const [cloneParent, setCloneParent] = createSignal(props.defaultCloneParent?.trim() ? props.defaultCloneParent : "~/")
  const [cloneFolder, setCloneFolder] = createSignal("")
  const [cloneFolderTouched, setCloneFolderTouched] = createSignal(false)
  const [cloneBaseRef, setCloneBaseRef] = createSignal(DEFAULT_BASE_REF)
  // True while a `git clone` subprocess is running. The dialog dims
  // its inputs and shows the latest stderr line while this is set;
  // Ctrl+[/] and tab cycling are gated to prevent state churn mid-clone.
  const [cloneInFlight, setCloneInFlight] = createSignal(false)
  const [cloneProgress, setCloneProgress] = createSignal<string>("")

  // Curated list: cwd + /add-repo entries, deduped. Used in saved
  // mode; substring-filtered against the typed input.
  const repoOptions = createMemo<readonly string[]>(() => computeRepoOptions(props.defaultRepo, props.savedRepos))

  // Mode flip — saved (curated list) vs browse (directory drill-down).
  // The memo over `repoOptions` makes the dialog open in saved mode
  // even though `repo()` is prefilled with the cwd (exact-match
  // shortcut in `pickerModeFor`).
  const mode = createMemo(() => pickerModeFor(repo(), repoOptions()))

  // Browse-mode plumbing for the existing tab: split the input into a
  // base dir (to readdir) and a partial leaf (to filter). When the
  // mode is "saved" the memos still recompute but their output is unused.
  const subdirSplit = createMemo(() => splitPathForDirSuggest(repo()))
  const subdirAll = createMemo<readonly string[]>(() => listSubdirs(subdirSplit().base))
  const subdirFiltered = createMemo<readonly string[]>(() => filterSubdirs(subdirAll(), subdirSplit().filter))

  // Saved-mode list: substring filter against repoOptions. Empty
  // input keeps the full list. The picker is augmenting the input,
  // not gating it, so an exact-match input still appears in the list.
  const savedFiltered = createMemo<readonly string[]>(() => filterRepos(repoOptions(), repo()))

  // The single list the keyboard / dropdown drives on the existing tab.
  const activeList = createMemo<readonly string[]>(() => (mode() === "browse" ? subdirFiltered() : savedFiltered()))
  const [repoCursor, setRepoCursor] = createSignal(0)
  const activeWindow = createMemo<PickerWindow>(() => windowAround(activeList(), repoCursor()))

  // Branch picker — refreshed whenever the repo path changes. The
  // baseRef field still accepts free text (so tags / commit SHAs / refs
  // not in the local branch list still work), but typing is augmented
  // with up/down navigation over the discovered branches: highlights
  // the cursor row and pre-fills the input as the user moves.
  // listLocalBranches doesn't expand `~`, so we resolve it here — same
  // as `commit()` does before validating.
  const branches = createMemo<readonly string[]>(() => listLocalBranches(expandHome(repo().trim())))
  const branchFiltered = createMemo<readonly string[]>(() => filterBranches(branches(), baseRef()))
  const [branchCursor, setBranchCursor] = createSignal(0)
  const branchWindow = createMemo<PickerWindow>(() => windowAround(branchFiltered(), branchCursor()))

  // Clone-tab parent-dir picker: same drill-down primitives as the
  // existing-tab browse mode, applied only when the user is on the
  // cloneParent field.
  const cloneParentSplit = createMemo(() => splitPathForDirSuggest(cloneParent()))
  const cloneParentAll = createMemo<readonly string[]>(() => listSubdirs(cloneParentSplit().base))
  const cloneParentFiltered = createMemo<readonly string[]>(() =>
    filterSubdirs(cloneParentAll(), cloneParentSplit().filter),
  )
  const [cloneParentCursor, setCloneParentCursor] = createSignal(0)
  const cloneParentWindow = createMemo<PickerWindow>(() => windowAround(cloneParentFiltered(), cloneParentCursor()))

  // Reset cursors whenever the filtered list changes — typing should
  // always land the highlight on the first match, otherwise the cursor
  // can sit on a now-hidden index and feels broken.
  createEffect(() => {
    void branchFiltered()
    setBranchCursor(0)
  })
  // Auto-sync baseRef to the repo's current branch when the user picks
  // a different repo. Skipped once the user has manually edited the
  // branch field — the override wins.
  createEffect(() => {
    const r = expandHome(repo().trim())
    if (!r) return
    if (baseRefTouched()) return
    const current = getCurrentBranch(r)
    if (current) setBaseRef(current)
  })
  createEffect(() => {
    void activeList()
    setRepoCursor(0)
  })
  createEffect(() => {
    void cloneParentFiltered()
    setCloneParentCursor(0)
  })
  // Folder name follows the URL until the user explicitly edits it.
  // Auto-suffixes (`name-2`, `name-3`, …) when the URL-derived name
  // would collide with an existing entry inside the chosen parent dir,
  // so a second clone of the same repo doesn't immediately fail
  // validation. Re-runs whenever URL OR parent changes; the user's
  // manual edits still win via `cloneFolderTouched`.
  createEffect(() => {
    const url = cloneUrl()
    const parent = cloneParent()
    if (cloneFolderTouched()) return
    const base = deriveFolderName(url)
    setCloneFolder(findAvailableFolderName(parent, base))
  })

  // Validation error shown inline when the user tries to submit a bad
  // repo path / URL / target. Null while the user is still typing — we
  // don't shout before they're done. Cleared on every keystroke that
  // changes any input field so the message doesn't linger after they
  // fix the typo.
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  createEffect(() => {
    void repo()
    void cloneUrl()
    void cloneParent()
    void cloneFolder()
    setSubmitError(null)
  })

  function commitExisting() {
    // expandHome before validating — `~/foo` won't fs.statSync without
    // resolution. We submit the expanded path so downstream consumers
    // (orchestrator.createTask, git worktree add) get an absolute one.
    const r = expandHome(repo().trim())
    if (!r) return
    const reason = validateRepoPath(r)
    if (reason) {
      setSubmitError(reason)
      setField("repo")
      return
    }
    const b = baseRef().trim() || DEFAULT_BASE_REF
    props.onSubmit({ repo: r, baseRef: b })
    dialog.clear()
  }

  async function commitClone() {
    if (cloneInFlight()) return
    const urlReason = validateGitUrl(cloneUrl())
    if (urlReason) {
      setSubmitError(urlReason)
      setField("cloneUrl")
      return
    }
    const targetReason = validateCloneTarget(cloneParent(), cloneFolder())
    if (targetReason) {
      setSubmitError(targetReason)
      setField(cloneFolder().trim() ? "cloneParent" : "cloneFolder")
      return
    }
    const target = resolveCloneTarget(cloneParent(), cloneFolder())
    setCloneInFlight(true)
    setCloneProgress(`Cloning into ${target}…`)
    const result = await cloneRepo(cloneUrl().trim(), target, (line) => {
      setCloneProgress(line)
    })
    setCloneInFlight(false)
    if (!result.ok) {
      setSubmitError(`git clone failed: ${result.error}`)
      setField("cloneUrl")
      return
    }
    const b = cloneBaseRef().trim() || DEFAULT_BASE_REF
    const parentDir = expandHome(cloneParent().trim())
    props.onSubmit({ repo: result.path, baseRef: b, cloned: { parentDir } })
    dialog.clear()
  }

  function commit() {
    if (tab() === "clone") {
      void commitClone()
      return
    }
    commitExisting()
  }

  function switchToTab(next: DialogTab) {
    if (cloneInFlight()) return
    if (next === tab()) return
    setTab(next)
    setField(firstFieldFor(next))
    setSubmitError(null)
  }

  // Enter on the repo field (existing tab). Pure selection — never
  // commits. Commit lives on the Create button at the bottom.
  function onRepoSubmit() {
    if (!repo().trim() && mode() === "saved") {
      const picked = activeList()[0]
      if (picked) {
        setRepo(picked)
        setField("baseRef")
        return
      }
    }
    if (mode() === "browse") {
      const list = subdirFiltered()
      const picked = list[repoCursor()]
      const split = subdirSplit()
      if (picked) {
        if (split.filter) {
          setRepo(joinDrill(repo(), split.base, picked))
          return
        }
        const resolved = expandHome(repo().trim())
        if (!resolved || validateRepoPath(resolved) !== null) {
          setRepo(joinDrill(repo(), split.base, picked))
          return
        }
      }
      setField("baseRef")
      return
    }
    const picked = activeList()[repoCursor()]
    if (picked) {
      setRepo(picked)
      setField("baseRef")
      return
    }
    setField("baseRef")
  }

  function selectRepoAtMouse(absoluteIndex: number): void {
    const list = activeList()
    const picked = list[absoluteIndex]
    if (!picked) return
    if (mode() === "browse") {
      const split = subdirSplit()
      setRepo(joinDrill(repo(), split.base, picked))
      setRepoCursor(absoluteIndex)
      return
    }
    setRepo(picked)
    setRepoCursor(absoluteIndex)
    setField("baseRef")
  }

  // Mirror of the existing-tab repo drill-down, but for the Clone
  // tab's cloneParent input. The Clone tab's parent picker is always
  // browse-mode (no saved-repo curation here — saved repos are an
  // "existing" concept).
  function onCloneParentSubmit() {
    const list = cloneParentFiltered()
    const picked = list[cloneParentCursor()]
    const split = cloneParentSplit()
    if (picked) {
      setCloneParent(joinDrill(cloneParent(), split.base, picked))
      return
    }
    setField("cloneFolder")
  }
  function selectCloneParentAtMouse(absoluteIndex: number): void {
    const list = cloneParentFiltered()
    const picked = list[absoluteIndex]
    if (!picked) return
    const split = cloneParentSplit()
    setCloneParent(joinDrill(cloneParent(), split.base, picked))
    setCloneParentCursor(absoluteIndex)
  }

  useBindings(() => ({
    bindings: [
      {
        // Tab cycles fields within the current sub-tab.
        key: "tab",
        cmd: () => setField((f) => nextField(f, tab())),
      },
      {
        // Ctrl+] → next sub-tab. With two tabs this toggles.
        key: "ctrl+]",
        cmd: () => switchToTab(nextDialogTab(tab())),
      },
      {
        // Ctrl+[ → previous sub-tab. With two tabs this toggles too.
        key: "ctrl+[",
        cmd: () => switchToTab(nextDialogTab(tab())),
      },
      {
        key: "up",
        cmd: () => {
          if (cloneInFlight()) return
          if (tab() === "existing" && field() === "repo") {
            const list = activeList()
            if (list.length === 0) return
            setRepoCursor(clampCursor(repoCursor() - 1, list.length))
            return
          }
          if (tab() === "existing" && field() === "baseRef") {
            const list = branchFiltered()
            if (list.length === 0) return
            setBranchCursor(clampCursor(branchCursor() - 1, list.length))
            return
          }
          if (tab() === "clone" && field() === "cloneParent") {
            const list = cloneParentFiltered()
            if (list.length === 0) return
            setCloneParentCursor(clampCursor(cloneParentCursor() - 1, list.length))
          }
        },
      },
      {
        key: "down",
        cmd: () => {
          if (cloneInFlight()) return
          if (tab() === "existing" && field() === "repo") {
            const list = activeList()
            if (list.length === 0) return
            setRepoCursor(clampCursor(repoCursor() + 1, list.length))
            return
          }
          if (tab() === "existing" && field() === "baseRef") {
            const list = branchFiltered()
            if (list.length === 0) return
            setBranchCursor(clampCursor(branchCursor() + 1, list.length))
            return
          }
          if (tab() === "clone" && field() === "cloneParent") {
            const list = cloneParentFiltered()
            if (list.length === 0) return
            setCloneParentCursor(clampCursor(cloneParentCursor() + 1, list.length))
          }
        },
      },
    ],
  }))

  // Enter on the Create button = commit. Lives in its own useBindings
  // call with a config-level `enabled` so the binding is OUT of the
  // dispatch stack while field !== "confirm" — otherwise the dispatcher
  // calls preventDefault() after firing the no-op cmd and swallows the
  // Enter before the focused input's onSubmit can see it.
  useBindings(() => ({
    enabled: field() === "confirm" && !cloneInFlight(),
    bindings: [
      {
        key: "return",
        cmd: () => commit(),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          New task
        </text>
        {/* Header-right Create button. Commits the active tab's form
            on click; the form is also reachable by tabbing to the
            confirm field and pressing Enter (handler shared via
            commit()). Lives in the header — not the bottom container —
            so its position stays anchored regardless of how tall the
            interactive surface below grows. */}
        <text
          fg={field() === "confirm" ? theme.primary : theme.text}
          attributes={field() === "confirm" ? TextAttributes.BOLD : undefined}
          onMouseUp={() => commit()}
        >
          {cloneInFlight() ? "[ Cloning… ]" : field() === "confirm" ? "▸ [ Create ]" : "[ Create ]"}
        </text>
      </box>
      {/* Top section — interactive surface: the sub-tab selector, the
          active tab's form fields. Sizes to content height so the
          dialog breathes with the active tab (existing has 2 fields,
          clone has 4). ctrl+[ / ctrl+] toggles tabs; mouse click
          selects. */}
      <box gap={1} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={2}>
          <text
            fg={tab() === "existing" ? theme.info : theme.textMuted}
            attributes={tab() === "existing" ? TextAttributes.BOLD : undefined}
            onMouseUp={() => switchToTab("existing")}
          >
            {tab() === "existing" ? "▸ For Existing" : "  For Existing"}
          </text>
          <text
            fg={tab() === "clone" ? theme.info : theme.textMuted}
            attributes={tab() === "clone" ? TextAttributes.BOLD : undefined}
            onMouseUp={() => switchToTab("clone")}
          >
            {tab() === "clone" ? "▸ For New Repo" : "  For New Repo"}
          </text>
        </box>
        <Show when={tab() === "existing"}>
          {/* ── Existing tab body ───────────────────────────────────── */}
          <box gap={0}>
            <text fg={field() === "repo" ? theme.accent : theme.textMuted}>repo</text>
            <input
              value={repo()}
              placeholder={props.defaultRepo}
              focused={field() === "repo"}
              onInput={(v: string) => setRepo(stripNewlines(v))}
              onSubmit={() => {
                if (!repo().trim()) return
                onRepoSubmit()
              }}
            />
          </box>
          <Show when={field() === "repo" && activeList().length > 0}>
            <box gap={0} paddingLeft={2}>
              <Show when={activeWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  ↑ {activeWindow().start} more
                </text>
              </Show>
              <For each={activeWindow().items}>
                {(name, i) => {
                  const absoluteIndex = () => activeWindow().start + i()
                  const isCursor = () => absoluteIndex() === repoCursor()
                  const isCurrentDir = () => mode() === "saved" && name === props.defaultRepo
                  const isSelected = () => mode() === "saved" && repo().trim() === name
                  const suffix = () => (mode() === "browse" ? "/" : "")
                  const tag = () => (isCurrentDir() ? "  (current dir)" : "")
                  return (
                    <text
                      fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                      attributes={isCursor() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      onMouseUp={() => selectRepoAtMouse(absoluteIndex())}
                    >
                      {isCursor() ? "▸ " : "  "}
                      {name}
                      {suffix()}
                      {tag()}
                    </text>
                  )
                }}
              </For>
              <Show when={activeWindow().start + activeWindow().items.length < activeWindow().total}>
                <text fg={theme.textMuted} wrapMode="none">
                  ↓ {activeWindow().total - activeWindow().start - activeWindow().items.length} more
                </text>
              </Show>
            </box>
          </Show>
          <box gap={0}>
            <text fg={field() === "baseRef" ? theme.accent : theme.textMuted}>from branch</text>
            <input
              value={baseRef()}
              placeholder={DEFAULT_BASE_REF}
              focused={field() === "baseRef"}
              onInput={(v: string) => {
                setBaseRefTouched(true)
                setBaseRef(stripNewlines(v))
              }}
              onSubmit={() => {
                setBaseRef(resolveBaseRef(baseRef(), branchFiltered(), branchCursor()))
                setBaseRefTouched(true)
                setField("confirm")
              }}
            />
          </box>
          <Show when={field() === "baseRef" && branchFiltered().length === 0 && submitError() == null}>
            <box gap={0} paddingLeft={2} paddingBottom={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {branches().length === 0
                  ? "(no local branches found — typed text will be used as ref)"
                  : "(no match — typed text will be used as ref)"}
              </text>
            </box>
          </Show>
          <Show when={field() === "baseRef" && branchFiltered().length > 0}>
            <box gap={0} paddingLeft={2} paddingBottom={1}>
              <Show when={branchWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  ↑ {branchWindow().start} more
                </text>
              </Show>
              <For each={branchWindow().items}>
                {(name, i) => {
                  const absoluteIndex = () => branchWindow().start + i()
                  const isCursor = () => absoluteIndex() === branchCursor()
                  const isSelected = () => baseRef().trim() === name
                  return (
                    <text
                      fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                      attributes={isCursor() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      onMouseUp={() => {
                        setBaseRef(name)
                        setBaseRefTouched(true)
                        setBranchCursor(absoluteIndex())
                        setField("confirm")
                      }}
                    >
                      {isCursor() ? "▸ " : "  "}
                      {name}
                    </text>
                  )
                }}
              </For>
              <Show when={branchWindow().start + branchWindow().items.length < branchWindow().total}>
                <text fg={theme.textMuted} wrapMode="none">
                  ↓ {branchWindow().total - branchWindow().start - branchWindow().items.length} more
                </text>
              </Show>
            </box>
          </Show>
        </Show>
        <Show when={tab() === "clone"}>
          {/* ── Clone tab body ──────────────────────────────────────── */}
          <box gap={0}>
            <text fg={field() === "cloneUrl" ? theme.accent : theme.textMuted}>git url</text>
            <input
              value={cloneUrl()}
              placeholder="https://github.com/user/repo.git"
              focused={field() === "cloneUrl"}
              onInput={(v: string) => setCloneUrl(stripNewlines(v))}
              onSubmit={() => {
                if (!cloneUrl().trim()) return
                setField("cloneParent")
              }}
            />
          </box>
          <box gap={0}>
            <text fg={field() === "cloneParent" ? theme.accent : theme.textMuted}>parent dir</text>
            <input
              value={cloneParent()}
              placeholder="~/"
              focused={field() === "cloneParent"}
              onInput={(v: string) => setCloneParent(stripNewlines(v))}
              onSubmit={() => onCloneParentSubmit()}
            />
          </box>
          {/* Persistence hint — surfaces the fact that this field
              remembers your last value across dialog opens (kv
              `lastClonedRepoParent`), so a follow-up clone defaults
              to the same parent. Only shown while the field is
              focused; sits between the input and the drill-down so
              the user sees it where they're already looking. */}
          <Show when={field() === "cloneParent"}>
            <box paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                (remembered — next clone defaults to this dir)
              </text>
            </box>
          </Show>
          <Show when={field() === "cloneParent" && cloneParentFiltered().length > 0}>
            <box gap={0} paddingLeft={2}>
              <Show when={cloneParentWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  ↑ {cloneParentWindow().start} more
                </text>
              </Show>
              <For each={cloneParentWindow().items}>
                {(name, i) => {
                  const absoluteIndex = () => cloneParentWindow().start + i()
                  const isCursor = () => absoluteIndex() === cloneParentCursor()
                  return (
                    <text
                      fg={isCursor() ? theme.primary : theme.textMuted}
                      attributes={isCursor() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      onMouseUp={() => selectCloneParentAtMouse(absoluteIndex())}
                    >
                      {isCursor() ? "▸ " : "  "}
                      {name}/
                    </text>
                  )
                }}
              </For>
              <Show when={cloneParentWindow().start + cloneParentWindow().items.length < cloneParentWindow().total}>
                <text fg={theme.textMuted} wrapMode="none">
                  ↓ {cloneParentWindow().total - cloneParentWindow().start - cloneParentWindow().items.length} more
                </text>
              </Show>
            </box>
          </Show>
          <box gap={0}>
            <text fg={field() === "cloneFolder" ? theme.accent : theme.textMuted}>folder name</text>
            <input
              value={cloneFolder()}
              placeholder="auto from url"
              focused={field() === "cloneFolder"}
              onInput={(v: string) => {
                setCloneFolderTouched(true)
                setCloneFolder(stripNewlines(v))
              }}
              onSubmit={() => setField("cloneBaseRef")}
            />
          </box>
          <box gap={0}>
            <text fg={field() === "cloneBaseRef" ? theme.accent : theme.textMuted}>base branch</text>
            <input
              value={cloneBaseRef()}
              placeholder={DEFAULT_BASE_REF}
              focused={field() === "cloneBaseRef"}
              onInput={(v: string) => setCloneBaseRef(stripNewlines(v))}
              onSubmit={() => setField("confirm")}
            />
          </box>
          <Show when={cloneInFlight()}>
            <box gap={0} paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {cloneProgress() || "Cloning…"}
              </text>
            </box>
          </Show>
        </Show>
        <Show when={submitError()}>
          <text fg={theme.error} wrapMode="word">
            ※ {submitError()}
          </text>
        </Show>
      </box>
      {/* Bottom hint legend — sits right below the form with no chrome
          around it; the Create button lives in the dialog header
          (top-right) so the action stays anchored as the form resizes.
          paddingTop separates it from the form above, paddingBottom
          gives the dialog's bottom edge breathing room. */}
      <box paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted}>↑↓ pick · enter select · tab next field · ctrl+[/] switch · esc cancel</text>
      </box>
    </box>
  )
}
