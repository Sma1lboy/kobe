import { readFileSync } from "node:fs"
import { submitFeedback } from "../lib/feedback.ts"

const FEEDBACK_USAGE = [
  "Usage: kobe feedback --title <text> (--body <text> | --body-file <path>) [--category <slug>]",
  "",
  "Create a GitHub Discussion in the kobe repository using the GitHub CLI.",
  "",
  "Requires:",
  "  gh auth login",
  "",
  "Options:",
  "  --title <text>       Discussion title",
  "  --body <text>        Discussion body",
  "  --body-file <path>   Read the Discussion body from a file; use - for stdin",
  "  --category <slug>    Discussion category slug (default: feedback)",
  "  -h, --help           Print this help",
  "",
].join("\n")

type ParsedFeedbackArgs = {
  help: boolean
  title?: string
  body?: string
  bodyFile?: string
  category?: string
}

function usageError(message: string): never {
  process.stderr.write(`kobe feedback: ${message}\n\n${FEEDBACK_USAGE}\n`)
  process.exit(2)
}

function readBodyFile(path: string): string {
  if (path === "-") return readFileSync(0, "utf8")
  return readFileSync(path, "utf8")
}

export function parseFeedbackArgs(args: readonly string[]): ParsedFeedbackArgs {
  const parsed: ParsedFeedbackArgs = { help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h" || arg === "help") return { ...parsed, help: true }
    if (arg === "--title") {
      parsed.title = args[++i]
      if (parsed.title === undefined) usageError("--title requires a value")
      continue
    }
    if (arg === "--body") {
      parsed.body = args[++i]
      if (parsed.body === undefined) usageError("--body requires a value")
      continue
    }
    if (arg === "--body-file") {
      parsed.bodyFile = args[++i]
      if (parsed.bodyFile === undefined) usageError("--body-file requires a value")
      continue
    }
    if (arg === "--category") {
      parsed.category = args[++i]
      if (parsed.category === undefined) usageError("--category requires a value")
      continue
    }
    usageError(`unexpected argument "${arg}"`)
  }
  return parsed
}

export async function runFeedbackSubcommand(args: readonly string[]): Promise<void> {
  const parsed = parseFeedbackArgs(args)
  if (parsed.help) {
    process.stdout.write(`${FEEDBACK_USAGE}\n`)
    return
  }
  if (!parsed.title) usageError("--title is required")
  if (parsed.body && parsed.bodyFile) usageError("pass either --body or --body-file, not both")

  const body = parsed.bodyFile ? readBodyFile(parsed.bodyFile) : parsed.body
  if (!body) usageError("--body or --body-file is required")

  const result = submitFeedback({
    title: parsed.title,
    body,
    categorySlug: parsed.category,
  })
  console.log(`created Discussion #${result.number}: ${result.url}`)
}
