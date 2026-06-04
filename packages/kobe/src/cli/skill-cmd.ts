/**
 * `kobe skill <verb>` — install + inspect the kobe agent skill.
 *
 * The skill is distributed through the Vercel Labs agent-skills CLI
 * (`npx skills add Sma1lboy/kobe`). `kobe skill install` is a thin
 * convenience WRAPPER around that flow so a developer doesn't have to
 * remember the exact `npx skills add … --skill kobe --agent …` invocation;
 * it shells out to `npx` with the right args. Verbs:
 *
 *   install [--agent NAME]   run the npx skills flow (default agent: claude-code)
 *   status                   report whether the skill is installed
 *   command [--agent NAME]   print the underlying npx command (don't run it)
 */

import {
  DEFAULT_SKILL_AGENT,
  kobeSkillPaths,
  kobeSkillState,
  npxSkillsArgv,
  npxSkillsCommand,
} from "../lib/skill-install.ts"

const SKILL_VERBS = ["install", "status", "command"] as const

function skillUsage(): string {
  return [
    "usage: kobe skill <verb>",
    "",
    "verbs:",
    "  install [--agent NAME]   Install the kobe agent skill (wraps `npx skills add`)",
    "  status                   Show whether the skill is installed",
    "  command [--agent NAME]   Print the underlying npx command without running it",
    "",
    `The skill teaches a coding agent how to drive \`kobe api\`. Default agent: ${DEFAULT_SKILL_AGENT}.`,
  ].join("\n")
}

/** Parse `--agent NAME` (the only flag these verbs take). */
function parseAgent(rest: readonly string[]): string {
  let agent = DEFAULT_SKILL_AGENT
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--agent") {
      const v = rest[i + 1]
      if (!v || v.startsWith("--")) {
        process.stderr.write("kobe skill: --agent requires a value\n")
        process.exit(2)
      }
      agent = v
      i++
    } else if (arg.startsWith("--agent=")) {
      agent = arg.slice("--agent=".length)
    } else {
      process.stderr.write(`kobe skill: unknown flag "${arg}"\n\n${skillUsage()}\n`)
      process.exit(2)
    }
  }
  return agent
}

export async function runSkillSubcommand(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(`${skillUsage()}\n`)
    if (!verb) process.exitCode = 2
    return
  }
  if (!SKILL_VERBS.includes(verb as (typeof SKILL_VERBS)[number])) {
    process.stderr.write(`kobe skill: unknown verb "${verb}"\n\n${skillUsage()}\n`)
    process.exit(2)
  }

  if (verb === "status") {
    const state = kobeSkillState()
    const [userPath, projectPath] = kobeSkillPaths()
    const head = !state.installed
      ? "✗ not installed"
      : state.stale
        ? `⚠ out of date (installed ${state.installedVersion === null ? "unstamped" : `v${state.installedVersion}`}, this kobe wants v${state.currentVersion})`
        : `✓ installed (v${state.installedVersion})`
    process.stdout.write(
      [
        `kobe skill: ${head}`,
        `  looked in: ${userPath}`,
        `             ${projectPath}`,
        state.installed && !state.stale ? "" : "  → run `kobe skill install` to install / refresh",
        "",
      ].join("\n"),
    )
    return
  }

  if (verb === "command") {
    process.stdout.write(`${npxSkillsCommand({ agent: parseAgent(rest) })}\n`)
    return
  }

  // install — shell out to the agent-skills CLI via npx.
  const agent = parseAgent(rest)
  const args = npxSkillsArgv({ agent })
  process.stdout.write(`kobe skill: running \`npx ${args.join(" ")}\`\n`)
  const proc = Bun.spawn(["npx", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) {
    process.stderr.write(
      `\nkobe skill install failed (npx exited ${code}). Is \`npx\` on PATH and are you online?\n` +
        `You can run it yourself: ${npxSkillsCommand({ agent })}\n`,
    )
    process.exit(code || 1)
  }
  process.stdout.write("kobe skill: installed.\n")
}
