import { isAbsolute, join, resolve } from "node:path"
import { homeDir } from "../env.ts"
import { loadStateFile } from "./store.ts"

export const WORKTREE_BASE_KEY = "worktree.basePath"

export const WORKTREE_BASE_CUSTOM_KEY = "worktree.basePath.custom"

export const PROJECT_DIR_TOKEN = "$project_dir"

export const PROJECT_SIBLING_BASE = `${PROJECT_DIR_TOKEN}/..`

export type WorktreeBaseKind = "default" | "nextToProject" | "custom"

export function worktreeBaseKindOf(raw: string): WorktreeBaseKind {
  const trimmed = raw.trim()
  if (!trimmed) return "default"
  if (trimmed.replace(/\/+$/, "") === PROJECT_SIBLING_BASE) return "nextToProject"
  return "custom"
}

export function hasProjectDirToken(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed === PROJECT_DIR_TOKEN || trimmed.startsWith(`${PROJECT_DIR_TOKEN}/`)
}

export function normalizeWorktreeBase(raw: string | undefined | null, projectDir?: string): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (hasProjectDirToken(trimmed)) {
    if (!projectDir) return null
    const rest = trimmed.slice(PROJECT_DIR_TOKEN.length).replace(/^\/+/, "")
    return resolve(projectDir, rest)
  }
  const home = homeDir()
  if (trimmed === "~") return home
  const expanded = trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : resolve(home, expanded)
}

export function getWorktreeBaseOverride(projectDir?: string): string | null {
  const value = loadStateFile()[WORKTREE_BASE_KEY]
  return normalizeWorktreeBase(typeof value === "string" ? value : null, projectDir)
}
