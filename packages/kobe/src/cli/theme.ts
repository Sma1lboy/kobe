import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { expandTilde } from "../lib/path-home.ts"
import { userThemesDir } from "../tui/context/theme/loader"
import { validateTheme } from "../tui/context/theme/schema"

const BUNDLED_NAMES: readonly string[] = [
  "claude",
  "conductor",
  "dracula",
  "nord",
  "opencode",
  "osaka-jade",
  "tokyonight",
]

function fail(message: string): never {
  process.stderr.write(`kobe theme: ${message}\n`)
  process.exit(1)
}

function failUsage(message: string): never {
  process.stderr.write(`kobe theme: ${message}\n\n`)
  printUsage()
  process.exit(2)
}

function listThemes(): void {
  const lines: string[] = []
  lines.push("bundled:")
  for (const name of [...BUNDLED_NAMES].sort()) {
    lines.push(`  ${name}  [built-in]`)
  }

  const dir = userThemesDir()
  let userFiles: string[] = []
  try {
    userFiles = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
  } catch {}
  lines.push("")
  lines.push(`user (${dir}):`)
  if (userFiles.length === 0) {
    lines.push("  (none)")
  } else {
    for (const f of userFiles) {
      const name = f.slice(0, -".json".length)
      const path = join(dir, f)
      const overridesBundled = BUNDLED_NAMES.includes(name) ? " (overrides built-in)" : ""
      lines.push(`  ${name}${overridesBundled}  ${path}`)
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`)
}

async function readSource(source: string): Promise<{ text: string; defaultName: string }> {
  if (/^https?:\/\//i.test(source)) {
    let res: Response
    try {
      res = await fetch(source)
    } catch (err) {
      fail(`failed to fetch ${source}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      fail(`failed to fetch ${source}: HTTP ${res.status} ${res.statusText}`)
    }
    const text = await res.text()
    const cleanPath = source.split(/[?#]/)[0] ?? source
    const file = basename(cleanPath) || "theme.json"
    const defaultName = file.endsWith(".json") ? file.slice(0, -".json".length) : file
    return { text, defaultName }
  }
  const abs = resolve(process.cwd(), expandTilde(source))
  let text: string
  try {
    text = readFileSync(abs, "utf8")
  } catch (err) {
    fail(`failed to read ${abs}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const file = basename(abs)
  const defaultName = file.endsWith(".json") ? file.slice(0, -".json".length) : file
  return { text, defaultName }
}

interface AddOpts {
  name?: string
  force: boolean
}

function parseAddArgs(args: string[]): { source: string; opts: AddOpts } {
  let source: string | null = null
  let name: string | undefined
  let force = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === "--force" || a === "-f") {
      force = true
      continue
    }
    if (a === "--name" || a === "-n") {
      const next = args[i + 1]
      if (next === undefined) failUsage("--name requires a value")
      name = next
      i += 1
      continue
    }
    if (a.startsWith("--name=")) {
      name = a.slice("--name=".length)
      continue
    }
    if (a.startsWith("--")) failUsage(`unknown flag: ${a}`)
    if (source === null) {
      source = a
      continue
    }
    failUsage(`unexpected positional argument: ${a}`)
  }
  if (source === null) failUsage("missing <source> (URL or path to theme JSON)")
  return { source, opts: { name, force } }
}

async function addTheme(args: string[]): Promise<void> {
  const { source, opts } = parseAddArgs(args)
  const { text, defaultName } = await readSource(source)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    fail(`source is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const result = validateTheme(parsed)
  if (!result.ok) {
    fail(`source is not a valid kobe theme: ${result.reason}`)
  }

  const name = opts.name ?? defaultName
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    fail(`invalid theme name "${name}" (use letters, digits, '.', '_', '-')`)
  }

  const dir = userThemesDir()
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${name}.json`)
  if (existsSync(dest) && !opts.force) {
    fail(`${dest} already exists (pass --force to overwrite)`)
  }
  writeFileSync(dest, `${JSON.stringify(result.theme, null, 2)}\n`, "utf8")
  process.stdout.write(`installed theme "${name}" -> ${dest}\n`)
}

function removeTheme(args: string[]): void {
  const name = args[0]
  if (!name) failUsage("missing <name>")
  if (args.length > 1) failUsage(`unexpected extra arguments after "${name}"`)
  if (BUNDLED_NAMES.includes(name)) {
    fail(`"${name}" is a built-in theme and cannot be removed`)
  }
  const dest = join(userThemesDir(), `${name}.json`)
  if (!existsSync(dest)) {
    fail(`no user theme named "${name}" (looked for ${dest})`)
  }
  unlinkSync(dest)
  process.stdout.write(`removed theme "${name}" (${dest})\n`)
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: kobe theme <command> [args]",
      "",
      "Commands:",
      "  list                          List bundled and user-installed themes",
      "  add <source> [--name <name>]  Install a theme from a URL or local path",
      "                                Pass --force to overwrite an existing user theme",
      "  remove <name>                 Remove a user-installed theme",
      "",
      `User themes live under: ${userThemesDir()}`,
      "Schema: https://raw.githubusercontent.com/sma1lboy/kobe/main/packages/kobe/src/tui/context/theme/theme.schema.json",
      "",
    ].join("\n"),
  )
}

export async function runThemeSubcommand(args: string[]): Promise<void> {
  const [action, ...rest] = args
  if (!action || action === "--help" || action === "-h" || action === "help") {
    printUsage()
    if (!action) process.exit(2)
    return
  }
  if (action === "list" || action === "ls") {
    if (rest.length > 0) failUsage(`"${action}" takes no arguments`)
    listThemes()
    return
  }
  if (action === "add") {
    await addTheme(rest)
    return
  }
  if (action === "remove" || action === "rm") {
    removeTheme(rest)
    return
  }
  failUsage(`unknown action "${action}" (try "list", "add", or "remove")`)
}
