/**
 * The new-task dialog JSX shell.
 *
 * Per the Wave 3 G architectural pivot, we no longer ask the user to
 * type a separate title — Claude Code does not store one (verified
 * against the stream-json schema), so anything we collect would be a
 * parallel piece of metadata users would have to maintain. Instead
 * we ask for two fields:
 *
 *   1. `repo path` — defaults to `process.cwd()`. The picker is the
 *      primary surface; the custom-path input below is the escape
 *      hatch.
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
import { useBindings } from "../../lib/keymap"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import {
  DEFAULT_BASE_REF,
  type Field,
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  computeRepoOptions,
  filterBranches,
  filterRepos,
  listLocalBranches,
  nextField,
  resolveBaseRef,
  stripNewlines,
  validateRepoPath,
  windowAround,
} from "./state"

export type NewTaskDialogProps = {
  onSubmit: (v: NewTaskInput) => void
  onCancel: () => void
  defaultRepo: string
  /**
   * User-curated repo list, persisted via `/add-repo`. Surfaced in the
   * dialog as a picker beneath the repo input. The current launch
   * directory (`defaultRepo`) is always prepended so the user can pick
   * "where I started kobe" without having to add it first.
   */
  savedRepos: readonly string[]
}

export function NewTaskDialogView(props: NewTaskDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Dialog only asks for repo + branch. The first prompt lives in the
  // chat composer — orchestrator.runTask back-fills the task title from
  // it on first submit (see PLACEHOLDER_TASK_TITLE in core.ts).
  const [field, setField] = createSignal<Field>("repoPicker")
  const [repo, setRepo] = createSignal(props.defaultRepo)
  const [baseRef, setBaseRef] = createSignal(DEFAULT_BASE_REF)

  // Repo picker — `defaultRepo` (cwd at launch) always appears first;
  // user-saved repos follow, deduped against the cwd. Up/down on the
  // repo field navigates this list and pre-fills the input so `enter`
  // commits the highlighted choice. Free-text editing is still allowed
  // — the picker is an affordance, not a constraint.
  const repoOptions = createMemo<readonly string[]>(() => computeRepoOptions(props.defaultRepo, props.savedRepos))
  // Substring filter against the repo input. Case-insensitive; empty
  // input returns the full list. The picker is augmenting the input,
  // not gating it, so an exact-match input still appears in the list.
  // While the picker (not the input) has focus, the filter is bypassed
  // so the user can browse the full list with arrow keys regardless
  // of whatever they typed earlier.
  const repoFiltered = createMemo<readonly string[]>(() => {
    const all = repoOptions()
    if (field() !== "repoCustom") return all
    return filterRepos(all, repo())
  })
  const [repoCursor, setRepoCursor] = createSignal(0)

  // Branch picker — refreshed whenever the repo path changes. The
  // baseRef field still accepts free text (so tags / commit SHAs / refs
  // not in the local branch list still work), but typing is augmented
  // with up/down navigation over the discovered branches: highlights
  // the cursor row and pre-fills the input as the user moves.
  const branches = createMemo<readonly string[]>(() => listLocalBranches(repo().trim()))
  // Type-to-filter on the baseRef input.
  const branchFiltered = createMemo<readonly string[]>(() => filterBranches(branches(), baseRef()))
  const [branchCursor, setBranchCursor] = createSignal(0)

  // Reset cursors whenever the filtered list changes — typing should
  // always land the highlight on the first match, otherwise the cursor
  // can sit on a now-hidden index and feels broken.
  createEffect(() => {
    void branchFiltered()
    setBranchCursor(0)
  })
  createEffect(() => {
    void repoFiltered()
    setRepoCursor(0)
  })

  const repoWindow = createMemo<PickerWindow>(() => windowAround(repoFiltered(), repoCursor()))
  const branchWindow = createMemo<PickerWindow>(() => windowAround(branchFiltered(), branchCursor()))

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
    const r = repo().trim()
    if (!r) return
    const reason = validateRepoPath(r)
    if (reason) {
      setSubmitError(reason)
      // Snap focus back to the custom-path input — that's the field
      // whose contents triggered the validation failure, so the user
      // can fix the typo right there.
      setField("repoCustom")
      return
    }
    const b = baseRef().trim() || DEFAULT_BASE_REF
    props.onSubmit({ repo: r, baseRef: b })
    dialog.clear()
  }

  // When the user picks a repo (enter on the picker row), commit the
  // selection and advance to the baseRef field. Common helper so the
  // mouse-click and keyboard-enter paths stay in lockstep.
  function selectRepoAt(absoluteIndex: number): void {
    const list = repoFiltered()
    const picked = list[absoluteIndex]
    if (!picked) return
    setRepo(picked)
    setRepoCursor(absoluteIndex)
    setField("baseRef")
  }

  useBindings(() => ({
    bindings: [
      {
        // Tab cycles repoPicker → repoCustom → baseRef → repoPicker.
        // Lowest-priority surface (custom path typing) sits between
        // the picker and the branch field.
        key: "tab",
        cmd: () => setField((f) => nextField(f)),
      },
      {
        key: "up",
        cmd: () => {
          if (field() === "repoPicker") {
            const list = repoFiltered()
            if (list.length === 0) return
            setRepoCursor(clampCursor(repoCursor() - 1, list.length))
            return
          }
          if (field() === "repoCustom") return
          if (field() !== "baseRef") return
          const list = branchFiltered()
          if (list.length === 0) return
          setBranchCursor(clampCursor(branchCursor() - 1, list.length))
        },
      },
      {
        key: "down",
        cmd: () => {
          if (field() === "repoPicker") {
            const list = repoFiltered()
            if (list.length === 0) return
            setRepoCursor(clampCursor(repoCursor() + 1, list.length))
            return
          }
          if (field() === "repoCustom") return
          if (field() !== "baseRef") return
          const list = branchFiltered()
          if (list.length === 0) return
          setBranchCursor(clampCursor(branchCursor() + 1, list.length))
        },
      },
      {
        // Enter on the picker = pick the highlighted repo + advance.
        // The repoCustom + baseRef paths handle their own enter via
        // the input's onSubmit hook.
        key: "return",
        cmd: () => {
          if (field() === "repoPicker") selectRepoAt(repoCursor())
        },
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
      {/* Primary surface: pick a repo from the list. First entry is
          the launch cwd (always present); the rest are user-curated
          via /add-repo. Browsing this list is the default flow — the
          user lands here on dialog open with the cursor on entry 0
          (current dir). Enter commits and advances to baseRef.
          Picker hidden when there are no candidate repos at all (rare
          — defaultRepo is always in the list). */}
      <Show when={repoOptions().length > 0}>
        <box gap={0}>
          <text fg={field() === "repoPicker" ? theme.accent : theme.textMuted}>pick a repo</text>
          <Show when={repoWindow().start > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              ↑ {repoWindow().start} more
            </text>
          </Show>
          <For each={repoWindow().items}>
            {(path, i) => {
              const absoluteIndex = () => repoWindow().start + i()
              const isCursor = () => field() === "repoPicker" && absoluteIndex() === repoCursor()
              const isSelected = () => repo().trim() === path
              const isCurrentDir = () => path === props.defaultRepo
              return (
                <text
                  fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                  attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => selectRepoAt(absoluteIndex())}
                >
                  {isCursor() ? "▸ " : "  "}
                  {path}
                  {isCurrentDir() ? "  (current dir)" : ""}
                </text>
              )
            }}
          </For>
          <Show when={repoWindow().start + repoWindow().items.length < repoWindow().total}>
            <text fg={theme.textMuted} wrapMode="none">
              ↓ {repoWindow().total - repoWindow().start - repoWindow().items.length} more
            </text>
          </Show>
        </box>
      </Show>
      {/* Secondary surface: custom-path input. Tab once from the
          picker to land here. Last-priority — only needed when the
          user wants a repo that's not in the saved list and they
          haven't run `/add-repo` for it yet. The label dims when the
          field isn't focused so the picker reads as the primary
          flow. */}
      <box gap={0}>
        <text fg={field() === "repoCustom" ? theme.accent : theme.textMuted}>or type a custom path</text>
        <input
          value={repo()}
          placeholder={props.defaultRepo}
          focused={field() === "repoCustom"}
          onInput={(v: string) => setRepo(stripNewlines(v))}
          onSubmit={() => {
            if (!repo().trim()) return
            commit()
          }}
        />
      </box>
      <Show when={submitError()}>
        <text fg={theme.error}>※ {submitError()}</text>
      </Show>
      <box gap={0}>
        <text fg={field() === "baseRef" ? theme.accent : theme.textMuted}>from branch</text>
        <input
          value={baseRef()}
          placeholder={DEFAULT_BASE_REF}
          focused={field() === "baseRef"}
          onInput={(v: string) => setBaseRef(stripNewlines(v))}
          onSubmit={() => {
            // Prefer the highlighted branch in the picker over the
            // typed text. Free-text only kicks in when nothing matches
            // (typed a tag / commit SHA the local branch list doesn't know).
            setBaseRef(resolveBaseRef(baseRef(), branchFiltered(), branchCursor()))
            commit()
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
                    setBranchCursor(absoluteIndex())
                    commit()
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
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>↑↓ pick · enter select · tab next field · esc cancel</text>
      </box>
    </box>
  )
}
