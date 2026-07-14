/** Architecture guard: the shipped runtime has one Hosted PTY execution path. */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url))
const RETIRED_ROOT = join(SRC_ROOT, "tmux")
const LEGACY_COMPAT = join(SRC_ROOT, "cli", "legacy-tmux.ts")
const LEGACY_IMPORTERS = new Set([join(SRC_ROOT, "cli", "doctor-cmd.ts"), join(SRC_ROOT, "cli", "reset-cmd.ts")])

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

  test("only the reset/doctor compatibility seam can reference tmux", () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => {
        const source = readFileSync(file, "utf8")
        if (source.includes("KOBE_TMUX")) return true
        return source.split("\n").some((line) => {
          if (line.trimStart().startsWith("//")) return false
          const importsLegacyCompat = /["'][^"']*legacy-tmux(?:\.ts)?["']/.test(line)
          const importsTmux =
            /^\s*(?:import|export)\b.*\bfrom\s*["'][^"']*tmux/i.test(line) || /\bimport\(\s*["'][^"']*tmux/i.test(line)
          const namesTmuxBinary = /["']tmux["']/.test(line)
          if (importsLegacyCompat) return !LEGACY_IMPORTERS.has(file)
          return importsTmux || (namesTmuxBinary && file !== LEGACY_COMPAT)
        })
      })
      .map((file) => relative(SRC_ROOT, file))

    expect(offenders, `retired runtime references: ${offenders.join(", ")}`).toEqual([])
    expect(existsSync(LEGACY_COMPAT)).toBe(true)
    const compatibilitySource = readFileSync(LEGACY_COMPAT, "utf8")
    expect(compatibilitySource).toContain('LEGACY_TMUX_SOCKET = "kobe"')
    expect(compatibilitySource).not.toContain("KOBE_TMUX")
  })
})
