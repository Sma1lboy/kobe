import { t } from "@/tui/i18n"
import { ALL_VENDORS, type VendorId, nextVendorWithin, prevVendorWithin } from "@/types/vendor"
import type { AdoptableWorktree } from "@/types/worktree"
import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { DEFAULT_BASE_REF, getCurrentBranch, listLocalBranches, validateRepoPath } from "../../lib/git-snapshot"
import { useBindings } from "../../lib/keymap"
import { expandHome, filterSubdirs, joinPicked, listSubdirs, splitPathForDirSuggest } from "../../lib/path-helpers"
import { useDialog } from "../../ui/dialog"
import {
  cloneRepo,
  deriveFolderName,
  findAvailableFolderName,
  resolveCloneTarget,
  validateCloneTarget,
  validateGitUrl,
} from "./clone"
import {
  type DialogTab,
  type Field,
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  computeRepoOptions,
  filterAdoptableByGlob,
  filterBranches,
  filterRepos,
  firstFieldFor,
  nextDialogTab,
  nextField,
  pickerModeFor,
  prevDialogTab,
  resolveBaseRef,
  stripNewlines,
  windowAround,
} from "./state"

export type NewTaskDialogProps = {
  onSubmit: (v: NewTaskInput) => void
  onCancel: () => void
  defaultRepo: string
  savedRepos: readonly string[]
  defaultCloneParent?: string
  defaultVendor?: VendorId
  availableVendors?: readonly VendorId[]
  discoverAdoptable?: (repo: string) => Promise<readonly AdoptableWorktree[]>
}

export function NewTaskDialogView(props: NewTaskDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const [tab, setTab] = createSignal<DialogTab>("existing")

  const availableVendors = (): readonly VendorId[] => {
    const a = props.availableVendors
    return a && a.length > 0 ? a : ALL_VENDORS
  }
  const initialVendor = ((): VendorId => {
    const set = availableVendors()
    const pref = props.defaultVendor ?? "claude"
    return set.includes(pref) ? pref : (set[0] ?? "claude")
  })()
  const [vendor, setVendor] = createSignal<VendorId>(initialVendor)

  const [field, setField] = createSignal<Field>("tabs")
  const [repo, setRepo] = createSignal(props.defaultRepo)
  const [baseRef, setBaseRef] = createSignal(getCurrentBranch(expandHome(props.defaultRepo.trim())) ?? DEFAULT_BASE_REF)
  const [baseRefTouched, setBaseRefTouched] = createSignal(false)

  const [cloneUrl, setCloneUrl] = createSignal("")
  const [cloneParent, setCloneParent] = createSignal(props.defaultCloneParent?.trim() ? props.defaultCloneParent : "~/")
  const [cloneFolder, setCloneFolder] = createSignal("")
  const [cloneFolderTouched, setCloneFolderTouched] = createSignal(false)
  const [cloneBaseRef, setCloneBaseRef] = createSignal(DEFAULT_BASE_REF)
  const [cloneInFlight, setCloneInFlight] = createSignal(false)
  const [cloneProgress, setCloneProgress] = createSignal<string>("")

  const repoOptions = createMemo<readonly string[]>(() => computeRepoOptions(props.defaultRepo, props.savedRepos))

  const mode = createMemo(() => pickerModeFor(repo(), repoOptions()))

  const subdirSplit = createMemo(() => splitPathForDirSuggest(repo()))
  const subdirAll = createMemo<readonly string[]>(() => listSubdirs(subdirSplit().base))
  const subdirFiltered = createMemo<readonly string[]>(() => filterSubdirs(subdirAll(), subdirSplit().filter))

  const savedFiltered = createMemo<readonly string[]>(() => filterRepos(repoOptions(), repo()))

  const activeList = createMemo<readonly string[]>(() => (mode() === "browse" ? subdirFiltered() : savedFiltered()))
  const [repoCursor, setRepoCursor] = createSignal(0)
  const activeWindow = createMemo<PickerWindow>(() => windowAround(activeList(), repoCursor()))
  const [repoPicked, setRepoPicked] = createSignal(false)

  const branches = createMemo<readonly string[]>(() => listLocalBranches(expandHome(repo().trim())))
  const branchFiltered = createMemo<readonly string[]>(() => filterBranches(branches(), baseRef()))
  const [branchCursor, setBranchCursor] = createSignal(0)
  const branchWindow = createMemo<PickerWindow>(() => windowAround(branchFiltered(), branchCursor()))

  const cloneParentSplit = createMemo(() => splitPathForDirSuggest(cloneParent()))
  const cloneParentAll = createMemo<readonly string[]>(() => listSubdirs(cloneParentSplit().base))
  const cloneParentFiltered = createMemo<readonly string[]>(() =>
    filterSubdirs(cloneParentAll(), cloneParentSplit().filter),
  )
  const [cloneParentCursor, setCloneParentCursor] = createSignal(0)
  const cloneParentWindow = createMemo<PickerWindow>(() => windowAround(cloneParentFiltered(), cloneParentCursor()))
  const [cloneParentPicked, setCloneParentPicked] = createSignal(false)

  const [adoptFilter, setAdoptFilter] = createSignal("")
  const [adoptCursor, setAdoptCursor] = createSignal(0)
  const [adoptSelected, setAdoptSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [adoptable] = createResource(
    () => (tab() === "adopt" ? expandHome(repo().trim()) : null),
    async (r) => (props.discoverAdoptable ? await props.discoverAdoptable(r) : []),
  )
  const adoptList = createMemo<readonly AdoptableWorktree[]>(() =>
    filterAdoptableByGlob(adoptable() ?? [], adoptFilter()),
  )
  const adoptWindow = createMemo<PickerWindow>(() =>
    windowAround(
      adoptList().map((w) => w.path),
      adoptCursor(),
    ),
  )
  const adoptVisible = createMemo<readonly AdoptableWorktree[]>(() => {
    const w = adoptWindow()
    return adoptList().slice(w.start, w.start + w.items.length)
  })
  createEffect(() => {
    void adoptList()
    setAdoptCursor((c) => clampCursor(c, adoptList().length))
  })
  createEffect((prev: string | undefined) => {
    const r = expandHome(repo().trim())
    if (prev !== undefined && r !== prev) {
      setAdoptSelected(new Set<string>())
      setAdoptCursor(0)
    }
    return r
  })

  function toggleAdopt(p: string): void {
    setAdoptSelected((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }
  function toggleAdoptCursor(): void {
    const w = adoptList()[adoptCursor()]
    if (w) toggleAdopt(w.path)
  }

  createEffect(() => {
    void branchFiltered()
    setBranchCursor(0)
  })
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
  createEffect(() => {
    const url = cloneUrl()
    const parent = cloneParent()
    if (cloneFolderTouched()) return
    const base = deriveFolderName(url)
    setCloneFolder(findAvailableFolderName(parent, base))
  })

  const [submitError, setSubmitError] = createSignal<string | null>(null)
  createEffect(() => {
    void repo()
    void cloneUrl()
    void cloneParent()
    void cloneFolder()
    void adoptFilter()
    setSubmitError(null)
  })

  function commitExisting() {
    const r = expandHome(repo().trim())
    if (!r) return
    const reason = validateRepoPath(r)
    if (reason) {
      setSubmitError(reason)
      setField("repo")
      return
    }
    const b = baseRef().trim() || DEFAULT_BASE_REF
    props.onSubmit({ repo: r, baseRef: b, vendor: vendor() })
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
      const folder = cloneFolder().trim()
      const folderStructurallyBad = !folder || folder.includes("/") || folder.includes("\\")
      const parentAtFault = !folderStructurallyBad && validateCloneTarget(cloneParent(), "__kobe_probe__") != null
      setField(parentAtFault ? "cloneParent" : "cloneFolder")
      return
    }
    const target = resolveCloneTarget(cloneParent(), cloneFolder())
    setCloneInFlight(true)
    setCloneProgress(t("newTask.clone.progressInto", { target }))
    const result = await cloneRepo(cloneUrl().trim(), target, (line) => {
      setCloneProgress(line)
    })
    setCloneInFlight(false)
    if (!result.ok) {
      setSubmitError(t("newTask.error.cloneFailed", { error: result.error }))
      setField("cloneUrl")
      return
    }
    const b = cloneBaseRef().trim() || DEFAULT_BASE_REF
    const parentDir = expandHome(cloneParent().trim())
    props.onSubmit({ repo: result.path, baseRef: b, vendor: vendor(), cloned: { parentDir } })
    dialog.clear()
  }

  function commitAdopt() {
    const list = adoptList()
    if (list.length === 0) {
      setSubmitError(t("newTask.error.noAdoptable"))
      return
    }
    const sel = adoptSelected()
    const chosen = sel.size > 0 ? list.filter((w) => sel.has(w.path)) : list.slice(adoptCursor(), adoptCursor() + 1)
    if (chosen.length === 0) return
    props.onSubmit({
      mode: "adopt",
      repo: expandHome(repo().trim()),
      vendor: vendor(),
      adopt: chosen.map((w) => ({ worktreePath: w.path, branch: w.branch })),
    })
    dialog.clear()
  }

  function commit() {
    if (tab() === "clone") {
      void commitClone()
      return
    }
    if (tab() === "adopt") {
      commitAdopt()
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

  function cycleTab(dir: 1 | -1) {
    if (cloneInFlight()) return
    const next = dir === 1 ? nextDialogTab(tab()) : prevDialogTab(tab())
    if (next === tab()) return
    setTab(next)
    setSubmitError(null)
    setField("tabs")
  }

  function cycleEngine(dir: 1 | -1) {
    setVendor((v) => (dir === 1 ? nextVendorWithin(availableVendors(), v) : prevVendorWithin(availableVendors(), v)))
  }

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
        setRepo(joinPicked(repo(), split.base, picked))
        setRepoCursor(0)
        setRepoPicked(true)
        setField("baseRef")
        return
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
      setRepo(joinPicked(repo(), split.base, picked))
      setRepoCursor(absoluteIndex)
      setRepoPicked(true)
      setField("baseRef")
      return
    }
    setRepo(picked)
    setRepoCursor(absoluteIndex)
    setField("baseRef")
  }

  function onCloneParentSubmit() {
    const list = cloneParentFiltered()
    const picked = list[cloneParentCursor()]
    const split = cloneParentSplit()
    if (picked) {
      setCloneParent(joinPicked(cloneParent(), split.base, picked))
      setCloneParentCursor(0)
      setCloneParentPicked(true)
      setField("cloneFolder")
      return
    }
    setField("cloneFolder")
  }
  function selectCloneParentAtMouse(absoluteIndex: number): void {
    const list = cloneParentFiltered()
    const picked = list[absoluteIndex]
    if (!picked) return
    const split = cloneParentSplit()
    setCloneParent(joinPicked(cloneParent(), split.base, picked))
    setCloneParentCursor(absoluteIndex)
    setCloneParentPicked(true)
    setField("cloneFolder")
  }

  const adoptSelectAll = () => {
    const list = adoptList()
    if (list.length === 0) return
    const allSelected = list.every((w) => adoptSelected().has(w.path))
    setAdoptSelected(allSelected ? new Set<string>() : new Set(list.map((w) => w.path)))
  }

  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        cmd: () => setField((f) => nextField(f, tab())),
      },
      {
        key: "ctrl+]",
        cmd: () => switchToTab(nextDialogTab(tab())),
      },
      {
        key: "ctrl+[",
        cmd: () => switchToTab(prevDialogTab(tab())),
      },
      {
        key: "ctrl+e",
        cmd: () => setVendor((v) => nextVendorWithin(availableVendors(), v)),
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
            return
          }
          if (tab() === "adopt") {
            const list = adoptList()
            if (list.length === 0) return
            setAdoptCursor(clampCursor(adoptCursor() - 1, list.length))
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
            return
          }
          if (tab() === "adopt") {
            const list = adoptList()
            if (list.length === 0) return
            setAdoptCursor(clampCursor(adoptCursor() + 1, list.length))
          }
        },
      },
      ...(field() === "tabs" || field() === "engine"
        ? [
            { key: "left", cmd: () => (field() === "tabs" ? cycleTab(-1) : cycleEngine(-1)) },
            { key: "right", cmd: () => (field() === "tabs" ? cycleTab(1) : cycleEngine(1)) },
            { key: "return", cmd: () => setField((f) => nextField(f, tab())) },
          ]
        : []),
      ...(tab() === "adopt" ? [{ key: "ctrl+a", cmd: adoptSelectAll }] : []),
    ],
  }))

  useBindings(() => ({
    enabled: field() === "confirm" && !cloneInFlight(),
    bindings: [
      {
        key: "return",
        cmd: () => commit(),
      },
    ],
  }))

  const labelFg = (f: Field) => (field() === f ? theme.primary : theme.textMuted)
  const labelAttrs = (f: Field) => (field() === f ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined)
  const selectedAttrs = (selected: boolean, focused: boolean) =>
    selected ? (focused ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.BOLD) : undefined

  return (
    <box paddingLeft={2} paddingRight={2} gap={0}>
      <box flexDirection="row">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("newTask.title")}
        </text>
      </box>
      {}
      <box gap={1} paddingTop={1} paddingBottom={1}>
        {}
        {(() => {
          const tabFocused = () => field() === "tabs"
          const tabFg = (active: boolean) => (active ? theme.primary : theme.textMuted)
          return (
            <box flexDirection="row" gap={2}>
              <text
                fg={tabFg(tab() === "existing")}
                attributes={selectedAttrs(tab() === "existing", tabFocused())}
                onMouseUp={() => switchToTab("existing")}
              >
                {tab() === "existing" ? `▸ ${t("newTask.tabs.existing")}` : `  ${t("newTask.tabs.existing")}`}
              </text>
              <text
                fg={tabFg(tab() === "clone")}
                attributes={selectedAttrs(tab() === "clone", tabFocused())}
                onMouseUp={() => switchToTab("clone")}
              >
                {tab() === "clone" ? `▸ ${t("newTask.tabs.clone")}` : `  ${t("newTask.tabs.clone")}`}
              </text>
              <text
                fg={tabFg(tab() === "adopt")}
                attributes={selectedAttrs(tab() === "adopt", tabFocused())}
                onMouseUp={() => switchToTab("adopt")}
              >
                {tab() === "adopt" ? `▸ ${t("newTask.tabs.adopt")}` : `  ${t("newTask.tabs.adopt")}`}
              </text>
            </box>
          )
        })()}
        {}
        <box gap={0}>
          <text fg={labelFg("engine")} attributes={labelAttrs("engine")}>
            {t("newTask.field.engine")}
          </text>
          <box flexDirection="row" gap={2}>
            <For each={availableVendors()}>
              {(v) => {
                const selected = () => vendor() === v
                return (
                  <text
                    fg={selected() ? theme.primary : theme.textMuted}
                    attributes={selected() ? TextAttributes.BOLD : undefined}
                    onMouseUp={() => setVendor(v)}
                  >
                    {selected() ? "▸ " : "  "}
                    {v}
                  </text>
                )
              }}
            </For>
            <box flexGrow={1} />
            <text fg={theme.textMuted}>{t("newTask.hint.engineCycle")}</text>
          </box>
        </box>
        <Show when={tab() === "existing"}>
          {}
          <box gap={0}>
            <text fg={labelFg("repo")} attributes={labelAttrs("repo")}>
              {t("newTask.field.repo")}
            </text>
            <input
              value={repo()}
              placeholder={props.defaultRepo}
              focused={field() === "repo"}
              onInput={(v: string) => {
                setRepoPicked(false)
                setRepo(stripNewlines(v))
              }}
              onSubmit={() => onRepoSubmit()}
            />
          </box>
          <Show when={field() === "repo" && activeList().length > 0 && !repoPicked()}>
            <box gap={0} paddingLeft={2}>
              <Show when={activeWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  {t("newTask.picker.moreAbove", { count: activeWindow().start })}
                </text>
              </Show>
              <For each={activeWindow().items}>
                {(name, i) => {
                  const absoluteIndex = () => activeWindow().start + i()
                  const isCursor = () => absoluteIndex() === repoCursor()
                  const isCurrentDir = () => mode() === "saved" && name === props.defaultRepo
                  const isSelected = () => mode() === "saved" && repo().trim() === name
                  const suffix = () => (mode() === "browse" ? "/" : "")
                  const tag = () => (isCurrentDir() ? `  ${t("newTask.hint.currentDir")}` : "")
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
                  {t("newTask.picker.moreBelow", {
                    count: activeWindow().total - activeWindow().start - activeWindow().items.length,
                  })}
                </text>
              </Show>
            </box>
          </Show>
          <box gap={0}>
            <text fg={labelFg("baseRef")} attributes={labelAttrs("baseRef")}>
              {t("newTask.field.fromBranch")}
            </text>
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
                commitExisting()
              }}
            />
          </box>
          <Show when={field() === "baseRef" && branchFiltered().length === 0 && submitError() == null}>
            <box gap={0} paddingLeft={2} paddingBottom={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {branches().length === 0 ? t("newTask.hint.noBranchesFound") : t("newTask.hint.noMatchBranch")}
              </text>
            </box>
          </Show>
          <Show when={field() === "baseRef" && branchFiltered().length > 0}>
            <box gap={0} paddingLeft={2} paddingBottom={1}>
              <Show when={branchWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  {t("newTask.picker.moreAbove", { count: branchWindow().start })}
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
                  {t("newTask.picker.moreBelow", {
                    count: branchWindow().total - branchWindow().start - branchWindow().items.length,
                  })}
                </text>
              </Show>
            </box>
          </Show>
        </Show>
        <Show when={tab() === "clone"}>
          {}
          <box gap={0}>
            <text fg={labelFg("cloneUrl")} attributes={labelAttrs("cloneUrl")}>
              {t("newTask.field.gitUrl")}
            </text>
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
            <text fg={labelFg("cloneParent")} attributes={labelAttrs("cloneParent")}>
              {t("newTask.field.parentDir")}
            </text>
            <input
              value={cloneParent()}
              placeholder="~/"
              focused={field() === "cloneParent"}
              onInput={(v: string) => {
                setCloneParentPicked(false)
                setCloneParent(stripNewlines(v))
              }}
              onSubmit={() => onCloneParentSubmit()}
            />
          </box>
          {}
          <Show when={field() === "cloneParent"}>
            <box paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {t("newTask.hint.remembered")}
              </text>
            </box>
          </Show>
          <Show when={field() === "cloneParent" && cloneParentFiltered().length > 0 && !cloneParentPicked()}>
            <box gap={0} paddingLeft={2}>
              <Show when={cloneParentWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  {t("newTask.picker.moreAbove", { count: cloneParentWindow().start })}
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
                  {t("newTask.picker.moreBelow", {
                    count: cloneParentWindow().total - cloneParentWindow().start - cloneParentWindow().items.length,
                  })}
                </text>
              </Show>
            </box>
          </Show>
          <box gap={0}>
            <text fg={labelFg("cloneFolder")} attributes={labelAttrs("cloneFolder")}>
              {t("newTask.field.folderName")}
            </text>
            <input
              value={cloneFolder()}
              placeholder={t("newTask.placeholder.folderName")}
              focused={field() === "cloneFolder"}
              onInput={(v: string) => {
                setCloneFolderTouched(true)
                setCloneFolder(stripNewlines(v))
              }}
              onSubmit={() => setField("cloneBaseRef")}
            />
          </box>
          <box gap={0}>
            <text fg={labelFg("cloneBaseRef")} attributes={labelAttrs("cloneBaseRef")}>
              {t("newTask.field.baseBranch")}
            </text>
            <input
              value={cloneBaseRef()}
              placeholder={DEFAULT_BASE_REF}
              focused={field() === "cloneBaseRef"}
              onInput={(v: string) => setCloneBaseRef(stripNewlines(v))}
              onSubmit={() => void commitClone()}
            />
          </box>
          <Show when={cloneInFlight()}>
            <box gap={0} paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {cloneProgress() || t("newTask.clone.progressFallback")}
              </text>
            </box>
          </Show>
        </Show>
        <Show when={tab() === "adopt"}>
          {}
          <box gap={0}>
            <text fg={labelFg("adoptFilter")} attributes={labelAttrs("adoptFilter")}>
              {t("newTask.field.adoptFilter")}
            </text>
            <input
              value={adoptFilter()}
              placeholder={t("newTask.placeholder.adoptFilter")}
              focused={field() === "adoptFilter"}
              onInput={(v: string) => setAdoptFilter(stripNewlines(v))}
              onSubmit={() => toggleAdoptCursor()}
            />
          </box>
          <box paddingLeft={2}>
            <text fg={theme.textMuted} wrapMode="none">
              {t("newTask.adopt.repoLine", { path: expandHome(repo().trim()) || t("newTask.adopt.repoNone") })}
            </text>
          </box>
          <Show when={adoptable.loading}>
            <box paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {t("newTask.hint.scanningWorktrees")}
              </text>
            </box>
          </Show>
          <Show when={!adoptable.loading && adoptList().length === 0}>
            <box paddingLeft={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {(adoptable() ?? []).length === 0 ? t("newTask.adopt.noUnlinked") : t("newTask.adopt.noMatch")}
              </text>
            </box>
          </Show>
          <Show when={adoptList().length > 0}>
            <box gap={0} paddingLeft={2}>
              <Show when={adoptWindow().start > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  {t("newTask.picker.moreAbove", { count: adoptWindow().start })}
                </text>
              </Show>
              <For each={adoptVisible()}>
                {(w, i) => {
                  const absoluteIndex = () => adoptWindow().start + i()
                  const isCursor = () => absoluteIndex() === adoptCursor()
                  const isChecked = () => adoptSelected().has(w.path)
                  const tags = () => [w.dirty ? "dirty" : "", w.kobeManaged ? "" : "external"].filter(Boolean).join(",")
                  return (
                    <text
                      fg={isCursor() ? theme.primary : isChecked() ? theme.accent : theme.textMuted}
                      attributes={isCursor() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      onMouseUp={() => {
                        setAdoptCursor(absoluteIndex())
                        toggleAdopt(w.path)
                      }}
                    >
                      {isCursor() ? "▸ " : "  "}
                      {isChecked() ? "[x] " : "[ ] "}
                      {w.branch}
                      {tags() ? `  (${tags()})` : ""}
                    </text>
                  )
                }}
              </For>
              <Show when={adoptWindow().start + adoptWindow().items.length < adoptWindow().total}>
                <text fg={theme.textMuted} wrapMode="none">
                  {t("newTask.picker.moreBelow", {
                    count: adoptWindow().total - adoptWindow().start - adoptWindow().items.length,
                  })}
                </text>
              </Show>
              <text fg={theme.textMuted} wrapMode="none">
                {adoptSelected().size > 0
                  ? t("newTask.adopt.hintSelected", { count: adoptSelected().size })
                  : t("newTask.adopt.hintDefault")}
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
      {}
      <box flexDirection="row" justifyContent="space-between" alignItems="center" paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted}>{t("newTask.hint.legend")}</text>
        <text
          fg={field() === "confirm" ? theme.primary : theme.text}
          attributes={field() === "confirm" ? TextAttributes.BOLD : undefined}
          onMouseUp={() => commit()}
        >
          {cloneInFlight()
            ? t("newTask.button.cloning")
            : field() === "confirm"
              ? t("newTask.button.createFocused")
              : t("newTask.button.create")}
        </text>
      </box>
    </box>
  )
}
