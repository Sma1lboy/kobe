import type { VendorId } from "@/types/vendor"
import type { AdoptableWorktree } from "@/types/worktree"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  filterAdoptableByGlob,
  stripNewlines,
  windowAround,
} from "../../../tui/component/new-task-dialog/state"
import { t } from "../../i18n"
import { toggleInSet, toggleSelectAll } from "./pure"

export function useAdoptState(args: {
  active: boolean
  expandedRepo: string
  vendor: VendorId
  discoverAdoptable: ((repo: string) => Promise<readonly AdoptableWorktree[]>) | undefined
  onSubmit: (v: NewTaskInput) => void
  clearDialog: () => void
  setSubmitError: (e: string | null) => void
}) {
  const [adoptFilter, setAdoptFilter] = useState("")
  const [adoptCursor, setAdoptCursor] = useState(0)
  const [adoptSelected, setAdoptSelected] = useState<ReadonlySet<string>>(new Set())
  const [adoptable, setAdoptable] = useState<readonly AdoptableWorktree[] | undefined>(undefined)
  const [adoptLoading, setAdoptLoading] = useState(false)

  const adoptList = useMemo(() => filterAdoptableByGlob(adoptable ?? [], adoptFilter), [adoptable, adoptFilter])
  const adoptWindow: PickerWindow = windowAround(
    adoptList.map((w) => w.path),
    adoptCursor,
  )
  const adoptVisible = adoptList.slice(adoptWindow.start, adoptWindow.start + adoptWindow.items.length)
  const adoptDiscoveredCount = (adoptable ?? []).length

  const { active, expandedRepo, discoverAdoptable } = args
  useEffect(() => {
    if (!active) return
    let disposed = false
    setAdoptLoading(true)
    void (async () => {
      let list: readonly AdoptableWorktree[] = []
      try {
        list = discoverAdoptable ? await discoverAdoptable(expandedRepo) : []
      } catch {
        list = []
      }
      if (disposed) return
      setAdoptable(list)
      setAdoptLoading(false)
    })()
    return () => {
      disposed = true
    }
  }, [active, expandedRepo, discoverAdoptable])

  useEffect(() => {
    setAdoptCursor((c) => clampCursor(c, adoptList.length))
  }, [adoptList])

  const prevRepo = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prevRepo.current !== undefined && prevRepo.current !== expandedRepo) {
      setAdoptSelected(new Set<string>())
      setAdoptCursor(0)
    }
    prevRepo.current = expandedRepo
  }, [expandedRepo])

  function setAdoptFilterText(v: string): void {
    setAdoptFilter(stripNewlines(v))
  }
  function toggleAdopt(path: string): void {
    setAdoptSelected((prev) => toggleInSet(prev, path))
  }
  function toggleAdoptCursor(): void {
    const w = adoptList[adoptCursor]
    if (w) toggleAdopt(w.path)
  }
  function pickAdoptAt(absoluteIndex: number): void {
    const w = adoptList[absoluteIndex]
    if (!w) return
    setAdoptCursor(absoluteIndex)
    toggleAdopt(w.path)
  }
  function adoptSelectAll(): void {
    setAdoptSelected((prev) =>
      toggleSelectAll(
        prev,
        adoptList.map((w) => w.path),
      ),
    )
  }
  function moveAdoptCursor(delta: 1 | -1): void {
    if (adoptList.length === 0) return
    setAdoptCursor((c) => clampCursor(c + delta, adoptList.length))
  }

  function commitAdopt(): void {
    if (adoptList.length === 0) {
      args.setSubmitError(t("newTask.error.noAdoptable"))
      return
    }
    const chosen =
      adoptSelected.size > 0
        ? adoptList.filter((w) => adoptSelected.has(w.path))
        : adoptList.slice(adoptCursor, adoptCursor + 1)
    if (chosen.length === 0) return
    args.onSubmit({
      mode: "adopt",
      repo: expandedRepo,
      vendor: args.vendor,
      adopt: chosen.map((w) => ({ worktreePath: w.path, branch: w.branch })),
    })
    args.clearDialog()
  }

  return {
    adoptFilter,
    adoptLoading,
    adoptDiscoveredCount,
    adoptList,
    adoptWindow,
    adoptVisible,
    adoptCursor,
    adoptSelected,
    setAdoptFilterText,
    toggleAdoptCursor,
    pickAdoptAt,
    adoptSelectAll,
    moveAdoptCursor,
    commitAdopt,
  }
}
