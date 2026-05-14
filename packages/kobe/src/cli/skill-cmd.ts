/**
 * `kobe skill <install|uninstall>` — copy / remove the bundled SKILL.md
 * into the user's Claude Code skills directory so the model knows when
 * to use `kobe api ...`.
 *
 * Design ref: [`docs/design/cli-api.md`](../../../docs/design/cli-api.md) §5.
 * The bundled skill source lives under `packages/kobe/share/skills/kobe/`
 * in dev and `<dist root>/share/skills/kobe/` after `bun run build`
 * (the build script copies `share/` into `dist/share/`).
 */

import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SKILL_REL_PATH = ".claude/skills/kobe/SKILL.md"

/**
 * Resolve the path to the bundled SKILL.md.
 *
 * Three layouts:
 *  - dev: `<repo>/packages/kobe/share/skills/kobe/SKILL.md`. From
 *    `import.meta.url` we are at `.../packages/kobe/src/cli/skill-cmd.ts`,
 *    so the share dir sits at `../../share/...`.
 *  - npm package: `<install-prefix>/dist/share/skills/kobe/SKILL.md`. The
 *    build script copies `share/` into `dist/share/`; this file is bundled
 *    into `dist/cli/index.js`, so `../share/...` resolves correctly.
 *  - standalone (`bun build --compile`): `import.meta.url` points into
 *    the embedded VFS (`/$bunfs` / `B:\~BUN`). We do NOT bundle `share/`
 *    into the standalone executable today; `kobe skill install` from a
 *    standalone binary throws an explicit error pointing the user at the
 *    npm install path. (Fix in a follow-up if/when standalone users ask.)
 */
function resolveBundledSkill(): string {
  const here = fileURLToPath(import.meta.url)
  if (here.startsWith("/$bunfs") || here.startsWith("B:\\~BUN")) {
    throw new Error(
      "kobe skill install is not yet supported from the standalone binary. " +
        "Install kobe from npm (`npm install -g @sma1lboy/kobe`) and re-run, " +
        "or copy share/skills/kobe/SKILL.md from the kobe source tree manually.",
    )
  }
  const dir = dirname(here)
  // dev: src/cli/ → ../../share/skills/kobe/SKILL.md (= packages/kobe/share/...)
  const sourcePath = resolve(dir, "../../share/skills/kobe/SKILL.md")
  if (existsSync(sourcePath)) return sourcePath
  // npm bundle: dist/cli/index.js → ../share/skills/kobe/SKILL.md (= dist/share/...)
  const distPath = resolve(dir, "../share/skills/kobe/SKILL.md")
  if (existsSync(distPath)) return distPath
  throw new Error(
    `kobe: bundled SKILL.md not found (looked at ${sourcePath} and ${distPath}). ` +
      "If you are running from source, the share/ directory should sit next to src/.",
  )
}

function resolveInstallTarget(): string {
  const home = process.env.HOME ?? homedir()
  return join(home, SKILL_REL_PATH)
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

async function runInstall(argv: readonly string[]): Promise<void> {
  const force = argv.includes("--yes") || argv.includes("--force")
  const source = resolveBundledSkill()
  const target = resolveInstallTarget()

  const existing = await readIfExists(target)
  const bundled = await readFile(source, "utf8")

  if (existing === bundled) {
    console.log(`kobe skill: already installed at ${target}`)
    return
  }

  if (existing !== null && !force) {
    const existingBytes = Buffer.byteLength(existing, "utf8")
    const bundledBytes = Buffer.byteLength(bundled, "utf8")
    console.error(
      `kobe skill: ${target} exists and differs from the bundled version ` +
        `(installed=${existingBytes}B, bundled=${bundledBytes}B). ` +
        "Re-run with --yes to overwrite, or `kobe skill uninstall` first.",
    )
    process.exit(2)
  }

  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  console.log(`kobe skill: installed ${target}`)
}

async function runUninstall(): Promise<void> {
  const target = resolveInstallTarget()
  try {
    await stat(target)
  } catch {
    console.log(`kobe skill: nothing to remove at ${target}`)
    return
  }
  await unlink(target)
  console.log(`kobe skill: removed ${target}`)
}

export async function runSkillSubcommand(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === "install") {
    await runInstall(rest)
    return
  }
  if (command === "uninstall" || command === "remove") {
    await runUninstall()
    return
  }
  console.error("usage: kobe skill <install|uninstall> [--yes]")
  process.exit(2)
}

/**
 * Read-only probe for `kobe diagnose`. Returns the installed path if the
 * SKILL.md exists at the canonical target location, or null otherwise.
 */
export function probeInstalledSkill(): { path: string; installed: boolean } {
  const target = resolveInstallTarget()
  return { path: target, installed: existsSync(target) }
}
