/**
 * Postinstall-style check for the preview pane's optional system
 * binaries. Runs after `bun install` and prints a coloured warning
 * (never blocks) listing anything missing along with the per-platform
 * install command.
 *
 *   chafa          required — image preview (sixel + character grid)
 *   ffmpeg/ffprobe required — animated GIF frame extraction
 *   rsvg-convert   optional — SVG → image preview (falls back to XML
 *                  syntax highlight when missing)
 *
 * Skipped on CI (CI env var set) and when KOBE_SKIP_DEP_CHECK=1, so
 * automated jobs don't spam logs with install hints we can't follow.
 */

import { spawn } from "node:child_process"
import { platform } from "node:os"

type Dep = {
  bin: string
  description: string
  required: boolean
  /** Some binaries use single-dash flags (ffmpeg) and reject `--version` with exit 1. */
  versionArg: string
}

const DEPS: readonly Dep[] = [
  { bin: "chafa", description: "image preview (sixel + character grid)", required: true, versionArg: "--version" },
  { bin: "ffmpeg", description: "animated GIF frame extraction", required: true, versionArg: "-version" },
  { bin: "ffprobe", description: "animated GIF metadata probe", required: true, versionArg: "-version" },
  { bin: "rsvg-convert", description: "SVG → image preview", required: false, versionArg: "--version" },
]

const INSTALL_HINTS: Readonly<Record<string, string>> = {
  linux: "sudo apt install chafa ffmpeg librsvg2-bin   # Debian/Ubuntu\n  sudo dnf install chafa ffmpeg librsvg2-tools  # Fedora\n  sudo pacman -S chafa ffmpeg librsvg          # Arch",
  darwin: "brew install chafa ffmpeg librsvg",
  win32: "winget install hpjansson.chafa\n  winget install Gyan.FFmpeg\n  winget install GNOME.Librsvg  # optional",
}

async function hasBin(bin: string, versionArg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, [versionArg], { stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}

const C = {
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
}

async function main(): Promise<void> {
  if (process.env.CI || process.env.KOBE_SKIP_DEP_CHECK === "1") return
  const results = await Promise.all(
    DEPS.map(async (d) => ({ ...d, present: await hasBin(d.bin, d.versionArg) })),
  )
  const missing = results.filter((r) => !r.present)
  if (missing.length === 0) return

  const requiredMissing = missing.filter((m) => m.required)
  const optionalMissing = missing.filter((m) => !m.required)

  console.log("")
  console.log(`${C.bold}kobe — preview-pane system dependencies${C.reset}`)
  for (const r of results) {
    const mark = r.present ? `${C.green}✓${C.reset}` : r.required ? `${C.red}✗${C.reset}` : `${C.yellow}!${C.reset}`
    const tag = r.required ? "(required)" : "(optional)"
    const status = r.present ? "found" : "missing"
    console.log(`  ${mark} ${r.bin.padEnd(13)} ${C.dim}${tag} ${r.description} — ${status}${C.reset}`)
  }
  if (requiredMissing.length > 0) {
    console.log(`${C.yellow}\nImage previews won't work until you install:${C.reset}`)
    console.log(`  ${requiredMissing.map((m) => m.bin).join(", ")}`)
  }
  if (optionalMissing.length > 0) {
    console.log(`${C.dim}\nOptional (graceful fallback if missing):${C.reset}`)
    console.log(`  ${optionalMissing.map((m) => m.bin).join(", ")}`)
  }
  const hint = INSTALL_HINTS[platform()]
  if (hint) {
    console.log(`${C.dim}\nInstall command:${C.reset}`)
    console.log(`  ${hint}`)
  }
  console.log(`${C.dim}\nSet KOBE_SKIP_DEP_CHECK=1 to suppress this check.${C.reset}`)
  console.log("")
}

await main()
