import { matchPathGlob } from "@/lib/path-glob"
import type { VendorId } from "@/types/vendor"
import { DEFAULT_BASE_REF } from "../../lib/git-snapshot"

export type NewTaskInput =
  | {
      mode?: "create"
      repo: string
      baseRef: string
      vendor: VendorId
      cloned?: { parentDir: string }
    }
  | {
      mode: "adopt"
      repo: string
      vendor: VendorId
      adopt: readonly { worktreePath: string; branch: string }[]
    }

export type DialogTab = "existing" | "clone" | "adopt"

export function nextDialogTab(tab: DialogTab): DialogTab {
  if (tab === "existing") return "clone"
  if (tab === "clone") return "adopt"
  return "existing"
}

export function prevDialogTab(tab: DialogTab): DialogTab {
  if (tab === "existing") return "adopt"
  if (tab === "clone") return "existing"
  return "clone"
}

export type Field =
  | "tabs"
  | "engine"
  | "repo"
  | "baseRef"
  | "cloneUrl"
  | "cloneParent"
  | "cloneFolder"
  | "cloneBaseRef"
  | "adoptFilter"
  | "confirm"

export type PickerMode = "saved" | "browse"

export function pickerModeFor(value: string, repoOptions: readonly string[]): PickerMode {
  const trimmed = value.trim()
  if (repoOptions.includes(trimmed)) return "saved"
  if (trimmed.startsWith("~")) return "browse"
  if (trimmed.includes("/")) return "browse"
  return "saved"
}

export const PICKER_MAX_VISIBLE = 8

export type PickerWindow = {
  items: readonly string[]
  start: number
  total: number
}

export function stripNewlines(v: string): string {
  return v.replace(/[\r\n]+/g, "")
}

export function isBlankText(v: string): boolean {
  return !/\S/u.test(v)
}

export function nextField(field: Field, tab: DialogTab = "existing"): Field {
  if (field === "confirm") return "tabs"
  if (field === "tabs") return "engine"
  if (field === "engine") return firstFieldFor(tab)
  if (tab === "clone") {
    if (field === "cloneUrl") return "cloneParent"
    if (field === "cloneParent") return "cloneFolder"
    if (field === "cloneFolder") return "cloneBaseRef"
    if (field === "cloneBaseRef") return "confirm"
    return "cloneUrl"
  }
  if (tab === "adopt") {
    return field === "adoptFilter" ? "confirm" : "adoptFilter"
  }
  if (field === "repo") return "baseRef"
  if (field === "baseRef") return "confirm"
  return "repo"
}

export function firstFieldFor(tab: DialogTab): Field {
  if (tab === "clone") return "cloneUrl"
  if (tab === "adopt") return "adoptFilter"
  return "repo"
}

export function filterAdoptableByGlob<T extends { path: string }>(list: readonly T[], glob: string): readonly T[] {
  const pattern = glob.trim()
  if (!pattern) return list
  return list.filter((w) => matchPathGlob(pattern, w.path))
}

export function computeRepoOptions(defaultRepo: string, savedRepos: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [defaultRepo, ...savedRepos]) {
    const t = p.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export function filterRepos(all: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return all
  return all.filter((p) => p.toLowerCase().includes(q))
}

export function filterBranches(all: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return all
  return all.filter((b) => b.toLowerCase().includes(q))
}

export function windowAround(list: readonly string[], cursor: number, cap = PICKER_MAX_VISIBLE): PickerWindow {
  const total = list.length
  if (total <= cap) return { items: list, start: 0, total }
  const half = Math.floor(cap / 2)
  let start = Math.max(0, cursor - half)
  if (start + cap > total) start = total - cap
  return { items: list.slice(start, start + cap), start, total }
}

export function clampCursor(cursor: number, listLength: number): number {
  if (listLength <= 0) return 0
  return Math.max(0, Math.min(listLength - 1, cursor))
}

export function resolveBaseRef(typed: string, filteredBranches: readonly string[], cursor: number): string {
  const t = typed.trim()
  const lower = t.toLowerCase()
  const exact = t ? filteredBranches.find((b) => b.toLowerCase() === lower) : undefined
  if (exact) return exact
  const picked = filteredBranches[cursor]
  if (picked) return picked
  return t || DEFAULT_BASE_REF
}
