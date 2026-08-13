/**
 * Disk loader for user-installed themes.
 *
 * Rove ships with a small set of bundled themes (`src/tui/context/theme/*.json`,
 * statically imported into theme.tsx). User-installed themes live under
 * `<roveStateDir()>/themes/*.json` and get registered into the runtime
 * theme registry at boot via `addTheme()`. They look identical on disk to
 * the bundled ones — same `defs` + `theme` shape — and can be authored
 * by hand or fetched via `rove theme add <url>`.
 *
 * Design choices:
 *   - **Sync.** Tiny file count (a user dropping in 5 themes is already
 *     a lot), and we want this to run BEFORE `<App />` mounts so the
 *     theme registry is populated before the ThemeProvider's `init`
 *     reads `hasTheme(props.theme)`. Going async would force `startApp`
 *     and `startTui` to await an extra step at boot for no real perf
 *     benefit at this scale.
 *   - **Never throws.** A single corrupt JSON or schema-mismatched file
 *     must NOT crash Rove at boot. We `console.warn` with the file path
 *     and the rejection reason and skip — same severity as a missing
 *     `claude` binary, which the diagnose path also reports rather than
 *     throws on.
 *   - **No directory creation.** If `~/.rove/themes/` doesn't exist, we
 *     return `[]`. Creating it eagerly would litter the user's home dir
 *     even when they never wanted user themes; we only create it when
 *     `rove theme add` writes the first file.
 *   - **Theme name = filename without `.json`.** Collisions with bundled
 *     names are allowed and the user wins (boot calls `addTheme` after
 *     the bundled set is registered, and `addTheme` overwrites). This
 *     mirrors how dotfile-style overrides work elsewhere — the user's
 *     copy beats the system's.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { errorMessage } from "@/lib/error-message"
import { roveStateDir } from "../../../env"
import type { ThemeJson } from "../theme-core"
import { validateTheme } from "./schema"

/** Directory under the Rove state root where user themes live. */
export function userThemesDir(): string {
  return join(roveStateDir(), "themes")
}

export type LoadedTheme = { name: string; theme: ThemeJson }

/**
 * Read every `*.json` in `<roveStateDir()>/themes/`, validate it, and
 * return the surviving entries. Invalid entries are skipped with a
 * `console.warn` describing the rejection — they do not throw.
 *
 * Sync; safe to call before mounting the ThemeProvider.
 */
export function loadUserThemes(): LoadedTheme[] {
  const dir = userThemesDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // ENOENT (most common: user has never run `rove theme add`) or
    // permission denied. Either way, no user themes today — return
    // empty silently. Don't warn here; a missing dir is the *normal*
    // case for fresh installs.
    return []
  }

  const out: LoadedTheme[] = []
  for (const file of entries) {
    if (!file.endsWith(".json")) continue
    const path = join(dir, file)
    let parsed: unknown
    try {
      const text = readFileSync(path, "utf8")
      parsed = JSON.parse(text)
    } catch (err) {
      const msg = errorMessage(err)
      console.warn(`[rove] skipping user theme ${path}: invalid JSON — ${msg}`)
      continue
    }
    const result = validateTheme(parsed)
    if (!result.ok) {
      console.warn(`[rove] skipping user theme ${path}: ${result.reason}`)
      continue
    }
    const name = file.slice(0, -".json".length)
    out.push({ name, theme: result.theme })
  }
  return out
}
