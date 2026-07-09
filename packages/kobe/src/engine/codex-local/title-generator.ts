import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type EngineTitleGenerator, parseGeneratedTitleJson } from "@/engine/title-generator"

const DEFAULT_TIMEOUT_MS = 20_000

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding task. The title should be clear enough that the user recognizes the task in a list. Use sentence case: capitalize only the first word and proper nouns.

Return only JSON with a single "title" field.
Do not inspect files, run commands, or use tools. Reply directly from the task conversation.

Good examples:
{"title": "Fix mobile login button"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client errors"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}

Task conversation:
`

export interface TitleCommand {
  readonly argv: readonly string[]
  readonly outputPath: string
}

export function buildCodexTitleCommand(
  modelId: string | undefined,
  description: string,
  outputPath: string,
): TitleCommand {
  const argv = [
    "codex",
    "exec",
    "--ephemeral",
    "--ignore-rules",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
    "--color",
    "never",
  ]
  if (modelId) argv.push("--model", modelId)
  argv.push(`${SESSION_TITLE_PROMPT}${description}`)
  return { argv, outputPath }
}

export interface SpawnResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CodexTitleGeneratorDeps {
  readonly modelId: () => string | undefined
  readonly cwd: () => string
  readonly outputPath: () => string
  readonly readFile: (path: string) => Promise<string>
  readonly spawn: (
    argv: readonly string[],
    opts: { readonly cwd: string; readonly signal?: AbortSignal },
  ) => Promise<SpawnResult>
}

const defaultDeps: CodexTitleGeneratorDeps = {
  modelId: () => undefined,
  cwd: () => process.env.HOME || process.cwd(),
  outputPath: () => join(tmpdir(), `kobe-codex-title-${randomUUID()}.json`),
  readFile: (path) => readFile(path, "utf8"),
  spawn: spawnCapture,
}

export const codexTitleGenerator: EngineTitleGenerator = {
  generateTitle(input, options) {
    return generateCodexTitle(input, defaultDeps, options)
  },
}

export async function generateCodexTitle(
  input: string,
  deps: CodexTitleGeneratorDeps = defaultDeps,
  options: { readonly signal?: AbortSignal } = {},
): Promise<string | null> {
  const description = input.trim()
  if (!description) return null
  try {
    const command = buildCodexTitleCommand(deps.modelId(), description, deps.outputPath())
    const result = await deps.spawn(command.argv, { cwd: deps.cwd(), signal: options.signal })
    if (result.exitCode !== 0) return null
    const finalMessage = await deps.readFile(command.outputPath).catch(() => "")
    return parseGeneratedTitleJson(finalMessage) ?? parseGeneratedTitleJson(result.stdout)
  } catch {
    return null
  }
}

async function spawnCapture(
  argv: readonly string[],
  opts: { readonly cwd: string; readonly signal?: AbortSignal },
): Promise<SpawnResult> {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), DEFAULT_TIMEOUT_MS)
  const abort = (): void => proc.kill()
  opts.signal?.addEventListener("abort", abort, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timeout)
    opts.signal?.removeEventListener("abort", abort)
  }
}
