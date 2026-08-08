/**
 * `kobe skill <verb>` — install + inspect the kobe agent skill.
 *
 * Installation shells out to the Vercel Labs agent-skills CLI, pointed at
 * the SKILL.md bundled in this install (no repo clone — see
 * `lib/skill-install.ts`). Which agents to install for is the CLI's call,
 * not kobe's: with no `--agent` it detects what's installed and prompts,
 * writing the real file to `.agents/skills` and symlinking the agent dirs
 * that want one. Verbs:
 *
 *   install [--agent NAME]…  run the npx skills flow (no flag = it asks)
 *   status                   report whether the skill is installed
 *   command [--agent NAME]…  print the underlying npx command (don't run it)
 */

import {
  bundledSkillDir,
  kobeSkillPaths,
  kobeSkillState,
  npxSkillsCommand,
  runNpxSkillsInstall,
} from "../lib/skill-install.ts"

const SKILL_VERBS = ["install", "status", "command"] as const

function skillUsage(): string {
  return [
    "usage: kobe skill <verb>",
    "",
    "verbs:",
    "  install [--agent NAME]…  Install the kobe agent skill (wraps `npx skills add`)",
    "  status                   Show whether the skill is installed",
    "  command [--agent NAME]…  Print the underlying npx command without running it",
    "",
    "The skill teaches a coding agent how to drive `kobe api`. With no --agent,",
    "the agent-skills CLI detects your installed agents and asks which to use;",
    "repeat --agent to name them yourself (e.g. --agent claude-code --agent codex).",
  ].join("\n")
}

/**
 * Parse repeated `--agent NAME` / `--agent=NAME` (the only flag these verbs
 * take). Empty result means "let the agent-skills CLI ask" — that's the
 * default, and the reason kobe carries no agent list of its own.
 */
function parseAgents(rest: readonly string[]): string[] {
  const agents: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--agent") {
      const v = rest[i + 1]
      if (!v || v.startsWith("--")) {
        process.stderr.write("kobe skill: --agent requires a value\n")
        process.exit(2)
      }
      agents.push(v)
      i++
    } else if (arg.startsWith("--agent=")) {
      agents.push(arg.slice("--agent=".length))
    } else {
      process.stderr.write(`kobe skill: unknown flag "${arg}"\n\n${skillUsage()}\n`)
      process.exit(2)
    }
  }
  // The CLI rejects a comma-joined list, and silently installing to only the
  // first of `--agent claude-code,codex` would be worse than saying so.
  const joined = agents.find((a) => a.includes(","))
  if (joined) {
    process.stderr.write(
      `kobe skill: --agent takes one name; repeat the flag instead of "${joined}"\n` +
        `  e.g. ${joined
          .split(",")
          .map((a) => `--agent ${a.trim()}`)
          .join(" ")}\n`,
    )
    process.exit(2)
  }
  return agents
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
    const paths = kobeSkillPaths()
    const head = !state.installed
      ? "✗ not installed"
      : state.stale
        ? `⚠ out of date (installed ${state.installedVersion === null ? "unstamped" : `v${state.installedVersion}`}, this kobe wants v${state.currentVersion})`
        : `✓ installed (v${state.installedVersion})`
    process.stdout.write(
      [
        `kobe skill: ${head}`,
        `  looked in: ${paths.join("\n             ")}`,
        state.installed && !state.stale ? "" : "  → run `kobe skill install` to install / refresh",
        "",
      ].join("\n"),
    )
    return
  }

  if (verb === "command") {
    process.stdout.write(`${npxSkillsCommand({ agent: parseAgents(rest) })}\n`)
    return
  }

  // install — shell out to the agent-skills CLI via npx. stdio is inherited,
  // so with no --agent its own picker runs here interactively.
  const agent = parseAgents(rest)
  const bundled = bundledSkillDir()
  process.stdout.write(
    `kobe skill: running \`${npxSkillsCommand({ agent })}\`\n${
      bundled ? "" : "kobe skill: no bundled skill found — falling back to a repo clone (large download).\n"
    }`,
  )
  const code = await runNpxSkillsInstall(agent)
  if (code !== 0) {
    process.stderr.write(
      `\nkobe skill install failed (npx exited ${code}). Is \`npx\` on PATH?\n` +
        `You can run it yourself: ${npxSkillsCommand({ agent })}\n`,
    )
    process.exit(code || 1)
  }
  process.stdout.write("kobe skill: installed.\n")
}
