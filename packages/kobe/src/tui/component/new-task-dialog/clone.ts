import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Readable } from "node:stream"
import { t } from "@/tui/i18n"
import { expandHome } from "../../lib/path-helpers"

type EventedCloneProcess = {
  readonly stderr: Readable | null
  on(event: "error", listener: (err: Error) => void): void
  on(event: "close", listener: (code: number | null) => void): void
}

export function deriveFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  const lastSlash = trimmed.lastIndexOf("/")
  const lastColon = trimmed.lastIndexOf(":")
  const cutAt = Math.max(lastSlash, lastColon)
  const tail = cutAt >= 0 ? trimmed.slice(cutAt + 1) : trimmed
  return tail.replace(/\.git$/i, "")
}

export function validateGitUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return t("newTask.error.gitUrlRequired")
  const hasProtocol = trimmed.includes("://")
  const hasScpSep = trimmed.includes("@") && trimmed.includes(":")
  const hasPathSep = trimmed.includes("/")
  if (!hasProtocol && !hasScpSep && !hasPathSep) {
    return t("newTask.error.gitUrlInvalid", { url: trimmed })
  }
  return null
}

export function validateCloneTarget(parentDir: string, folder: string): string | null {
  const folderTrimmed = folder.trim()
  if (!folderTrimmed) return t("newTask.error.folderRequired")
  if (folderTrimmed.includes("/") || folderTrimmed.includes("\\")) {
    return t("newTask.error.folderHasSeparator")
  }
  const parentTrimmed = parentDir.trim()
  if (!parentTrimmed) return t("newTask.error.parentRequired")
  const parentExpanded = expandHome(parentTrimmed)
  let parentStat: fs.Stats
  try {
    parentStat = fs.statSync(parentExpanded)
  } catch {
    return t("newTask.error.parentNotFound", { path: parentExpanded })
  }
  if (!parentStat.isDirectory()) return t("newTask.error.parentNotDir", { path: parentExpanded })
  const target = path.join(parentExpanded, folderTrimmed)
  if (fs.existsSync(target)) return t("newTask.error.targetExists", { path: target })
  return null
}

export function resolveCloneTarget(parentDir: string, folder: string): string {
  return path.join(expandHome(parentDir.trim()), folder.trim())
}

export function findAvailableFolderName(parentDir: string, base: string): string {
  const trimmed = base.trim()
  if (!trimmed) return base
  const parentExpanded = expandHome(parentDir.trim())
  if (!parentExpanded) return base
  try {
    const stat = fs.statSync(parentExpanded)
    if (!stat.isDirectory()) return base
  } catch {
    return base
  }
  if (!fs.existsSync(path.join(parentExpanded, trimmed))) return trimmed
  for (let n = 2; n < 1000; n++) {
    const candidate = `${trimmed}-${n}`
    if (!fs.existsSync(path.join(parentExpanded, candidate))) return candidate
  }
  return trimmed
}

export type CloneResult = { ok: true; path: string } | { ok: false; error: string }

export type CloneProgress = (line: string) => void

export function cloneRepo(url: string, target: string, onProgress?: CloneProgress): Promise<CloneResult> {
  return new Promise<CloneResult>((resolve) => {
    let stderrBuf = ""
    try {
      const child = spawn("git", ["clone", "--progress", url, target], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      }) as unknown as EventedCloneProcess
      child.stderr?.setEncoding("utf-8")
      child.stderr?.on("data", (chunk: string) => {
        stderrBuf += chunk
        if (onProgress) {
          const lines = chunk.split(/[\r\n]+/).filter((s) => s.trim().length > 0)
          const last = lines[lines.length - 1]
          if (last) onProgress(last)
        }
      })
      child.on("error", (err: Error) => {
        resolve({ ok: false, error: err.message })
      })
      child.on("close", (code: number | null) => {
        if (code === 0) {
          resolve({ ok: true, path: target })
          return
        }
        const tail =
          stderrBuf
            .split(/[\r\n]+/)
            .filter((s) => s.trim().length > 0)
            .pop() ?? `git clone exited with ${code}`
        resolve({ ok: false, error: tail })
      })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
