/** Architecture guard: the shipped runtime has one Hosted PTY execution path. */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url))
const RETIRED_ROOT = join(SRC_ROOT, "tmux")

function sourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, files)
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe("Hosted PTY-only runtime boundary", () => {
  test("the retired runtime directory is absent", () => {
    expect(existsSync(RETIRED_ROOT)).toBe(false)
  })

  test("production sources cannot import, spawn, or configure the retired backend", () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => {
        const source = readFileSync(file, "utf8")
        if (source.includes("KOBE_TMUX")) return true
        return source.split("\n").some((line) => {
          if (line.trimStart().startsWith("//")) return false
          return (
            /^\s*(?:import|export)\b.*\bfrom\s*["'][^"']*tmux/i.test(line) ||
            /\bimport\(\s*["'][^"']*tmux/i.test(line) ||
            /^\s*(?:await\s+)?(?:Bun\.)?(?:spawn|spawnSync|execFile|execFileSync)\s*\([^\n]*["']tmux["']/i.test(line)
          )
        })
      })
      .map((file) => relative(SRC_ROOT, file))

    expect(offenders, `retired runtime references: ${offenders.join(", ")}`).toEqual([])
  })
})
