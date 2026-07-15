/** `kobe config`: open kobe's single user config file in your editor. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kvStatePath } from "../env.ts"
import { binaryAvailable, resolveEditorCommand } from "../tui/lib/editor-launch.ts"

function printUsage(out: Pick<typeof process.stderr, "write">): void {
  out.write(
    [
      "Usage: kobe config [--path]",
      "",
      "Open kobe's user config (state.json — theme, locale, engine + editor prefs)",
      "in your editor. The editor is $VISUAL / $EDITOR, else your configured editor",
      "(Settings → General → Editor), else the first of nvim / vim / emacs / nano.",
      "kobe re-reads the file on its next launch.",
      "",
      "Options:",
      "  --path        Print the config file path and exit (don't open an editor)",
      "  -h, --help    Print this help",
      "",
    ].join("\n"),
  )
}

export async function runConfigSubcommand(argv: readonly string[] = []): Promise<void> {
  if (argv.some((a) => a === "-h" || a === "--help" || a === "help")) {
    printUsage(process.stdout)
    return
  }
  const path = kvStatePath()
  if (argv.some((a) => a === "--path" || a === "path")) {
    console.log(path)
    return
  }
  const unknown = argv.find((a) => a.length > 0)
  if (unknown !== undefined) {
    process.stderr.write(`kobe config: unexpected argument "${unknown}"\n`)
    printUsage(process.stderr)
    process.exit(2)
  }

  // Editors open a missing path as a blank "new file" buffer; seed an empty
  // object so first-run `kobe config` lands on real, valid JSON instead.
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{}\n")
  }

  const resolved = await resolveEditorCommand(path)
  if (!resolved || !(await binaryAvailable(resolved.bin))) {
    process.stderr.write(
      `kobe config: no editor found — set $EDITOR (or Settings → General → Editor), or edit directly:\n  ${path}\n`,
    )
    process.exit(1)
  }

  // Inherit stdio so the terminal editor takes over this TTY; exit with its
  // code so `:cq` / a non-zero quit propagates.
  const proc = Bun.spawn(["sh", "-c", resolved.command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exit(await proc.exited)
}
