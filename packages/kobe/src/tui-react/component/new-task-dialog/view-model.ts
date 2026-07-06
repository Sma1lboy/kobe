import { type VendorId, nextVendorWithin, prevVendorWithin } from "@/types/vendor"
import type { AdoptableWorktree } from "@/types/worktree"
import { useEffect, useMemo, useState } from "react"
import {
  type DialogTab,
  type Field,
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  computeRepoOptions,
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
} from "../../../tui/component/new-task-dialog/state"
import { DEFAULT_BASE_REF, getCurrentBranch, listLocalBranches, validateRepoPath } from "../../../tui/lib/git-snapshot"
import { expandHome, joinPicked } from "../../../tui/lib/path-helpers"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import { resolveInitialVendor, resolveVendorSet } from "./pure"
import { useAdoptState } from "./use-adopt-state"
import { useCloneState } from "./use-clone-state"
import { useDerivedDir } from "./use-derived-dir"

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

export function useNewTaskViewModel(props: NewTaskDialogProps) {
  const dialog = useDialog()

  const [tab, setTab] = useState<DialogTab>("existing")
  const vendors = resolveVendorSet(props.availableVendors)
  const [vendor, setVendor] = useState<VendorId>(() =>
    resolveInitialVendor(resolveVendorSet(props.availableVendors), props.defaultVendor),
  )
  const [field, setField] = useState<Field>("tabs")
  const [repo, setRepo] = useState(props.defaultRepo)
  const [baseRef, setBaseRef] = useState(
    () => getCurrentBranch(expandHome(props.defaultRepo.trim())) ?? DEFAULT_BASE_REF,
  )
  const [baseRefTouched, setBaseRefTouched] = useState(false)

  const [repoCursor, setRepoCursor] = useState(0)
  const [repoPicked, setRepoPicked] = useState(false)
  const [branchCursor, setBranchCursor] = useState(0)

  const [submitError, setSubmitError] = useState<string | null>(null)

  const repoOptions = useMemo(
    () => computeRepoOptions(props.defaultRepo, props.savedRepos),
    [props.defaultRepo, props.savedRepos],
  )
  const mode = pickerModeFor(repo, repoOptions)
  const { split: subdirSplit, filtered: subdirFiltered } = useDerivedDir(repo)
  const savedFiltered = useMemo(() => filterRepos(repoOptions, repo), [repoOptions, repo])
  const activeList = mode === "browse" ? subdirFiltered : savedFiltered
  const activeWindow: PickerWindow = windowAround(activeList, repoCursor)

  const expandedRepo = expandHome(repo.trim())
  const branches = useMemo(() => listLocalBranches(expandedRepo), [expandedRepo])
  const branchFiltered = useMemo(() => filterBranches(branches, baseRef), [branches, baseRef])
  const branchWindow: PickerWindow = windowAround(branchFiltered, branchCursor)

  const clone = useCloneState({
    defaultCloneParent: props.defaultCloneParent,
    vendor,
    onSubmit: props.onSubmit,
    clearDialog: () => dialog.clear(),
    setField,
    setSubmitError,
  })
  const adopt = useAdoptState({
    active: tab === "adopt",
    expandedRepo,
    vendor,
    discoverAdoptable: props.discoverAdoptable,
    onSubmit: props.onSubmit,
    clearDialog: () => dialog.clear(),
    setSubmitError,
  })

  useEffect(() => {
    if (!expandedRepo || baseRefTouched) return
    const current = getCurrentBranch(expandedRepo)
    if (current) setBaseRef(current)
  }, [expandedRepo, baseRefTouched])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the inputs are the invalidation keys — any edit clears the inline error.
  useEffect(() => {
    setSubmitError(null)
  }, [repo, clone.cloneUrl, clone.cloneParent, clone.cloneFolder, adopt.adoptFilter])

  function setRepoText(v: string): void {
    setRepoPicked(false)
    setRepo(stripNewlines(v))
    setRepoCursor(0)
    setBranchCursor(0)
  }
  function setBaseRefText(v: string): void {
    setBaseRefTouched(true)
    setBaseRef(stripNewlines(v))
    setBranchCursor(0)
  }

  function commitExisting(): void {
    const r = expandedRepo
    if (!r) return
    const reason = validateRepoPath(r)
    if (reason) {
      setSubmitError(reason)
      setField("repo")
      return
    }
    const b = baseRef.trim() || DEFAULT_BASE_REF
    props.onSubmit({ repo: r, baseRef: b, vendor })
    dialog.clear()
  }

  function commit(): void {
    if (tab === "clone") {
      void clone.commitClone()
      return
    }
    if (tab === "adopt") {
      adopt.commitAdopt()
      return
    }
    commitExisting()
  }

  function switchToTab(next: DialogTab): void {
    if (clone.cloneInFlight || next === tab) return
    setTab(next)
    setField(firstFieldFor(next))
    setSubmitError(null)
  }

  function cycleTab(dir: 1 | -1): void {
    if (clone.cloneInFlight) return
    const next = dir === 1 ? nextDialogTab(tab) : prevDialogTab(tab)
    if (next === tab) return
    setTab(next)
    setSubmitError(null)
    setField("tabs")
  }

  function cycleEngine(dir: 1 | -1): void {
    setVendor((v) => (dir === 1 ? nextVendorWithin(vendors, v) : prevVendorWithin(vendors, v)))
  }

  function onRepoSubmit(): void {
    if (!repo.trim() && mode === "saved") {
      const picked = activeList[0]
      if (picked) {
        setRepo(picked)
        setField("baseRef")
        return
      }
    }
    if (mode === "browse") {
      const picked = subdirFiltered[repoCursor]
      if (picked) {
        setRepo(joinPicked(repo, subdirSplit.base, picked))
        setRepoCursor(0)
        setRepoPicked(true)
      }
      setField("baseRef")
      return
    }
    const picked = activeList[repoCursor]
    if (picked) setRepo(picked)
    setField("baseRef")
  }

  function selectRepoAt(absoluteIndex: number): void {
    const picked = activeList[absoluteIndex]
    if (!picked) return
    if (mode === "browse") {
      setRepo(joinPicked(repo, subdirSplit.base, picked))
      setRepoPicked(true)
    } else {
      setRepo(picked)
    }
    setRepoCursor(absoluteIndex)
    setField("baseRef")
  }

  function pickBranchAt(absoluteIndex: number): void {
    const name = branchFiltered[absoluteIndex]
    if (!name) return
    setBaseRef(name)
    setBaseRefTouched(true)
    setBranchCursor(absoluteIndex)
    setField("confirm")
  }

  function onBaseRefSubmit(): void {
    setBaseRef(resolveBaseRef(baseRef, branchFiltered, branchCursor))
    setBaseRefTouched(true)
    commitExisting()
  }

  function moveCursor(delta: 1 | -1): void {
    if (clone.cloneInFlight) return
    if (tab === "existing" && field === "repo" && activeList.length > 0) {
      setRepoCursor((c) => clampCursor(c + delta, activeList.length))
      return
    }
    if (tab === "existing" && field === "baseRef" && branchFiltered.length > 0) {
      setBranchCursor((c) => clampCursor(c + delta, branchFiltered.length))
      return
    }
    if (tab === "clone" && field === "cloneParent") {
      clone.moveParentCursor(delta)
      return
    }
    if (tab === "adopt") adopt.moveAdoptCursor(delta)
  }

  useBindings(() => ({
    bindings: [
      { key: "tab", cmd: () => setField((f) => nextField(f, tab)) },
      { key: "ctrl+]", cmd: () => switchToTab(nextDialogTab(tab)) },
      { key: "ctrl+[", cmd: () => switchToTab(prevDialogTab(tab)) },
      { key: "ctrl+e", cmd: () => cycleEngine(1) },
      { key: "up", cmd: () => moveCursor(-1) },
      { key: "down", cmd: () => moveCursor(1) },
      ...(field === "tabs" || field === "engine"
        ? [
            { key: "left", cmd: () => (field === "tabs" ? cycleTab(-1) : cycleEngine(-1)) },
            { key: "right", cmd: () => (field === "tabs" ? cycleTab(1) : cycleEngine(1)) },
            { key: "return", cmd: () => setField((f) => nextField(f, tab)) },
          ]
        : []),
      ...(tab === "adopt" ? [{ key: "ctrl+a", cmd: adopt.adoptSelectAll }] : []),
    ],
  }))

  useBindings(() => ({
    enabled: field === "confirm" && !clone.cloneInFlight,
    bindings: [{ key: "return", cmd: () => commit() }],
  }))

  return {
    ...clone,
    ...adopt,
    defaultRepo: props.defaultRepo,
    tab,
    vendors,
    vendor,
    setVendor,
    field,
    setField,
    repo,
    mode,
    activeList,
    activeWindow,
    repoCursor,
    repoPicked,
    expandedRepo,
    baseRef,
    branches,
    branchFiltered,
    branchWindow,
    branchCursor,
    submitError,
    setRepoText,
    setBaseRefText,
    onRepoSubmit,
    selectRepoAt,
    pickBranchAt,
    onBaseRefSubmit,
    switchToTab,
    commit,
    commitExisting,
  }
}

export type NewTaskVm = ReturnType<typeof useNewTaskViewModel>
