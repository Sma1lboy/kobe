/**
 * The new-task dialog JSX shell.
 *
 * Per the Wave 3 G architectural pivot, we no longer ask the user to
 * type a separate title — Claude Code does not store one (verified
 * against the stream-json schema), so anything we collect would be a
 * parallel piece of metadata users would have to maintain. Instead
 * we ask for two fields:
 *
 *   1. `repo` — defaults to `process.cwd()`. A single editable input
 *      with a smart dropdown that swaps between two surfaces based on
 *      what the user typed (see `pickerModeFor`):
 *        - saved mode (default, empty / short input): substring-filter
 *          the curated saved-repo list (cwd + /add-repo entries).
 *        - browse mode (user typed a path): directory drill-down.
 *      The two surfaces used to be separate fields (`repoPicker` +
 *      `repoCustom`); collapsing them removes the "Tab to find the
 *      drill-down" friction the prior layout introduced.
 *   2. `baseRef` — branch the worktree is forked from. Defaults to
 *      `main`. The branch picker augments the input so the user can
 *      arrow + enter rather than retype.
 *
 * Pure logic (field cycling, repo dedup, filtering, windowing,
 * validation, branch enumeration) lives in `./state.ts` so it can be
 * unit-tested without standing up the dialog stack or opentui.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import {
  DEFAULT_BASE_REF,
  type Field,
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  computeRepoOptions,
  expandHome,
  filterBranches,
  filterRepos,
  filterSubdirs,
  getCurrentBranch,
  joinDrill,
  listLocalBranches,
  listSubdirs,
  nextField,
  pickerModeFor,
  resolveBaseRef,
  splitPathForDirSuggest,
  stripNewlines,
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
}

export function NewTaskDialogView(props: NewTaskDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Dialog only asks for repo + branch. The first prompt lives in the
  // chat composer — orchestrator.runTask back-fills the task title from
  // it on first submit (see PLACEHOLDER_TASK_TITLE in core.ts).
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

  // Curated list: cwd + /add-repo entries, deduped. Used in saved
  // mode; substring-filtered against the typed input.
  const repoOptions = createMemo<readonly string[]>(() => computeRepoOptions(props.defaultRepo, props.savedRepos))

  // Mode flip — saved (curated list) vs browse (directory drill-down).
  // The memo over `repoOptions` makes the dialog open in saved mode
  // even though `repo()` is prefilled with the cwd (exact-match
  // shortcut in `pickerModeFor`).
  const mode = createMemo(() => pickerModeFor(repo(), repoOptions()))

  // Browse-mode plumbing: split the input into a base dir (to readdir)
  // and a partial leaf (to filter). When the mode is "saved" the
  // memos still recompute but their output is unused.
  const subdirSplit = createMemo(() => splitPathForDirSuggest(repo()))
  const subdirAll = createMemo<readonly string[]>(() => listSubdirs(subdirSplit().base))
  const subdirFiltered = createMemo<readonly string[]>(() => filterSubdirs(subdirAll(), subdirSplit().filter))

  // Saved-mode list: substring filter against repoOptions. Empty
  // input keeps the full list. The picker is augmenting the input,
  // not gating it, so an exact-match input still appears in the list.
  const savedFiltered = createMemo<readonly string[]>(() => filterRepos(repoOptions(), repo()))

  // The single list the keyboard / dropdown drives, based on mode.
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

  // Validation error shown inline when the user tries to submit a bad
  // repo path. Null while the user is still typing — we don't shout
  // before they're done. Cleared on every keystroke that changes the
  // repo field so the message doesn't linger after they fix the typo.
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  createEffect(() => {
    void repo()
    setSubmitError(null)
  })

  function commit() {
    // expandHome before validating — `~/foo` won't fs.statSync without
    // resolution. We submit the expanded path so downstream consumers
    // (orchestrator.createTask, git worktree add) get an absolute one.
    const r = expandHome(repo().trim())
    if (!r) return
    const reason = validateRepoPath(r)
    if (reason) {
      setSubmitError(reason)
      // Snap focus back to the repo input so the user can fix the typo
      // right there.
      setField("repo")
      return
    }
    const b = baseRef().trim() || DEFAULT_BASE_REF
    props.onSubmit({ repo: r, baseRef: b })
    dialog.clear()
  }

  // Enter on the repo field. Pure selection — never commits. Commit
  // lives on the confirm button at the bottom.
  //   - browse + filter non-empty (mid-completion): drill into the
  //     highlight (replace input with `base + name + "/"`).
  //   - browse + filter empty + something to drill into + path not yet
  //     a valid repo: drill another level.
  //   - browse + filter empty + path is a valid repo: advance to
  //     baseRef so the user can pick a branch.
  //   - saved + highlighted entry exists: pick the highlight into the
  //     input and advance to baseRef.
  //   - empty / nothing highlighted: advance to baseRef.
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
      // Mouse click on a subdir = drill (replace input with
      // base + name + "/", let the user keep browsing). Mirrors
      // the keyboard Enter behavior for browse mode.
      const split = subdirSplit()
      setRepo(joinDrill(repo(), split.base, picked))
      setRepoCursor(absoluteIndex)
      return
    }
    // Saved mode: click = pick + advance to baseRef (no commit; the
    // user confirms from the Create button).
    setRepo(picked)
    setRepoCursor(absoluteIndex)
    setField("baseRef")
  }

  useBindings(() => ({
    bindings: [
      {
        // Tab cycles repo ↔ baseRef.
        key: "tab",
        cmd: () => setField((f) => nextField(f)),
      },
      {
        key: "up",
        cmd: () => {
          if (field() === "repo") {
            const list = activeList()
            if (list.length === 0) return
            setRepoCursor(clampCursor(repoCursor() - 1, list.length))
            return
          }
          if (field() !== "baseRef") return
          const list = branchFiltered()
          if (list.length === 0) return
          setBranchCursor(clampCursor(branchCursor() - 1, list.length))
        },
      },
      {
        key: "down",
        cmd: () => {
          if (field() === "repo") {
            const list = activeList()
            if (list.length === 0) return
            setRepoCursor(clampCursor(repoCursor() + 1, list.length))
            return
          }
          if (field() !== "baseRef") return
          const list = branchFiltered()
          if (list.length === 0) return
          setBranchCursor(clampCursor(branchCursor() + 1, list.length))
        },
      },
    ],
  }))

  // Enter on the Create button = commit. Lives in its own useBindings
  // call with a config-level `enabled` so the binding is OUT of the
  // dispatch stack while field !== "confirm" — otherwise the dispatcher
  // calls preventDefault() after firing the no-op cmd and swallows the
  // Enter before the focused repo/baseRef input's onSubmit can see it.
  useBindings(() => ({
    enabled: field() === "confirm",
    bindings: [
      {
        key: "return",
        cmd: () => commit(),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          New task
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      {/* Unified repo input. Free-text + smart dropdown below. The
          dropdown swaps between saved-repo and subdir-browse modes
          based on what's typed (see `pickerModeFor`). */}
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
      {/* Dropdown for the repo input. Two render branches sharing
          the same activeWindow / repoCursor signals — only one
          renders at a time, decided by mode(). */}
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
      <Show when={submitError()}>
        <text fg={theme.error}>※ {submitError()}</text>
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
            // Prefer the highlighted branch in the picker over the
            // typed text. Free-text only kicks in when nothing matches
            // (typed a tag / commit SHA the local branch list doesn't know).
            // Pure selection — advance to the Create button, don't commit.
            setBaseRef(resolveBaseRef(baseRef(), branchFiltered(), branchCursor()))
            setBaseRefTouched(true)
            setField("confirm")
          }}
        />
      </box>
      {/* Branch picker empty-state: the repo had no discoverable
          local branches, OR the user typed a filter that doesn't
          match any. Either way show a soft hint so the user knows
          their typed text will be used as a literal ref (tag / SHA
          / remote ref) rather than chosen from a list. */}
      <Show
        when={
          field() === "baseRef" &&
          branchFiltered().length === 0 &&
          // Don't shout when validateRepoPath has already complained
          // about the upstream issue.
          submitError() == null
        }
      >
        <box gap={0} paddingLeft={2} paddingBottom={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {branches().length === 0
              ? "(no local branches found — typed text will be used as ref)"
              : "(no match — typed text will be used as ref)"}
          </text>
        </box>
      </Show>
      {/* Branch picker: rendered when on baseRef field and the repo
          actually has discoverable branches matching the input. Up/down
          navigate the (windowed) list; click selects + commits. The
          ↑/↓ N more indicators surface truncation when the repo has
          more matching branches than the cap. */}
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
      {/* Bottom row: hint text on the left, Create button on the
          right. The button is the only path that commits — every
          keyboard / mouse interaction above is pure selection. */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.textMuted}>↑↓ pick · enter select · tab next field · esc cancel</text>
        <text
          fg={field() === "confirm" ? theme.primary : theme.text}
          attributes={field() === "confirm" ? TextAttributes.BOLD : undefined}
          onMouseUp={() => commit()}
        >
          {field() === "confirm" ? "▸ [ Create ]" : "  [ Create ]"}
        </text>
      </box>
    </box>
  )
}
