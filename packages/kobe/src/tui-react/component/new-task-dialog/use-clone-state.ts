/**
 * Clone-tab state hook for the React new-task dialog (issue #15, G3W2) —
 * the "For New Repo" cluster split out of `./view-model.ts`: git URL,
 * parent-dir drill-down picker, auto-derived folder name, base branch,
 * and the async `git clone` commit path. All fs/spawn plumbing comes from
 * the shared `src/tui/component/new-task-dialog/clone.ts`.
 */

import type { VendorId } from "@/types/vendor"
import { useEffect, useState } from "react"
import {
  cloneRepo,
  deriveFolderName,
  findAvailableFolderName,
  resolveCloneTarget,
  validateCloneTarget,
  validateGitUrl,
} from "../../../tui/component/new-task-dialog/clone"
import {
  type Field,
  type NewTaskInput,
  type PickerWindow,
  clampCursor,
  stripNewlines,
  windowAround,
} from "../../../tui/component/new-task-dialog/state"
import { DEFAULT_BASE_REF } from "../../../tui/lib/git-snapshot"
import { expandHome, joinPicked } from "../../../tui/lib/path-helpers"
import { t } from "../../i18n"
import { useDerivedDir } from "./use-derived-dir"

export function useCloneState(args: {
  defaultCloneParent: string | undefined
  vendor: VendorId
  onSubmit: (v: NewTaskInput) => void
  clearDialog: () => void
  setField: (f: Field) => void
  setSubmitError: (e: string | null) => void
}) {
  const [cloneUrl, setCloneUrl] = useState("")
  const [cloneParent, setCloneParent] = useState(args.defaultCloneParent?.trim() ? args.defaultCloneParent : "~/")
  const [cloneFolder, setCloneFolder] = useState("")
  const [cloneFolderTouched, setCloneFolderTouched] = useState(false)
  const [cloneBaseRef, setCloneBaseRef] = useState(DEFAULT_BASE_REF)
  // True while `git clone` runs — inputs dim, tab switching is gated.
  const [cloneInFlight, setCloneInFlight] = useState(false)
  const [cloneProgress, setCloneProgress] = useState("")
  const [cloneParentCursor, setCloneParentCursor] = useState(0)
  // "Selected, not drilled" latch — collapses the dropdown after Enter/click.
  const [cloneParentPicked, setCloneParentPicked] = useState(false)

  const { split: cloneParentSplit, filtered: cloneParentFiltered } = useDerivedDir(cloneParent)
  const cloneParentWindow: PickerWindow = windowAround(cloneParentFiltered, cloneParentCursor)

  // Folder name follows the URL until manually edited; auto-suffixes on
  // collision inside the chosen parent dir.
  useEffect(() => {
    if (cloneFolderTouched) return
    setCloneFolder(findAvailableFolderName(cloneParent, deriveFolderName(cloneUrl)))
  }, [cloneUrl, cloneParent, cloneFolderTouched])

  function setCloneUrlText(v: string): void {
    setCloneUrl(stripNewlines(v))
  }
  function setCloneParentText(v: string): void {
    setCloneParentPicked(false)
    setCloneParent(stripNewlines(v))
    setCloneParentCursor(0)
  }
  function setCloneFolderText(v: string): void {
    setCloneFolderTouched(true)
    setCloneFolder(stripNewlines(v))
  }
  function setCloneBaseRefText(v: string): void {
    setCloneBaseRef(stripNewlines(v))
  }

  function onCloneParentSubmit(): void {
    const picked = cloneParentFiltered[cloneParentCursor]
    if (picked) {
      setCloneParent(joinPicked(cloneParent, cloneParentSplit.base, picked))
      setCloneParentCursor(0)
      setCloneParentPicked(true)
    }
    args.setField("cloneFolder")
  }

  function selectCloneParentAt(absoluteIndex: number): void {
    const picked = cloneParentFiltered[absoluteIndex]
    if (!picked) return
    setCloneParent(joinPicked(cloneParent, cloneParentSplit.base, picked))
    setCloneParentCursor(absoluteIndex)
    setCloneParentPicked(true)
    args.setField("cloneFolder")
  }

  function moveParentCursor(delta: 1 | -1): void {
    if (cloneParentFiltered.length === 0) return
    setCloneParentCursor((c) => clampCursor(c + delta, cloneParentFiltered.length))
  }

  async function commitClone(): Promise<void> {
    if (cloneInFlight) return
    const urlReason = validateGitUrl(cloneUrl)
    if (urlReason) {
      args.setSubmitError(urlReason)
      args.setField("cloneUrl")
      return
    }
    const targetReason = validateCloneTarget(cloneParent, cloneFolder)
    if (targetReason) {
      args.setSubmitError(targetReason)
      // Blame the field actually at fault — same probe strategy as the
      // Solid shell (see its commitClone for the full rationale).
      const folder = cloneFolder.trim()
      const folderStructurallyBad = !folder || folder.includes("/") || folder.includes("\\")
      const parentAtFault = !folderStructurallyBad && validateCloneTarget(cloneParent, "__kobe_probe__") != null
      args.setField(parentAtFault ? "cloneParent" : "cloneFolder")
      return
    }
    const target = resolveCloneTarget(cloneParent, cloneFolder)
    setCloneInFlight(true)
    setCloneProgress(t("newTask.clone.progressInto", { target }))
    const result = await cloneRepo(cloneUrl.trim(), target, (line) => setCloneProgress(line))
    setCloneInFlight(false)
    if (!result.ok) {
      args.setSubmitError(t("newTask.error.cloneFailed", { error: result.error }))
      args.setField("cloneUrl")
      return
    }
    const b = cloneBaseRef.trim() || DEFAULT_BASE_REF
    args.onSubmit({
      repo: result.path,
      baseRef: b,
      vendor: args.vendor,
      cloned: { parentDir: expandHome(cloneParent.trim()) },
    })
    args.clearDialog()
  }

  return {
    cloneUrl,
    cloneParent,
    cloneFolder,
    cloneBaseRef,
    cloneInFlight,
    cloneProgress,
    cloneParentFiltered,
    cloneParentWindow,
    cloneParentCursor,
    cloneParentPicked,
    setCloneUrlText,
    setCloneParentText,
    setCloneFolderText,
    setCloneBaseRefText,
    onCloneParentSubmit,
    selectCloneParentAt,
    moveParentCursor,
    commitClone,
  }
}
