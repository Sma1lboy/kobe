/**
 * `kobe completions` — generate shell completion scripts.
 *
 * Usage:
 *   kobe completions bash   > ~/.bash_completion.d/kobe
 *   kobe completions zsh    > ~/.zsh/completions/_kobe
 *   kobe completions fish   > ~/.config/fish/completions/kobe.fish
 *
 * The generated scripts complete subcommands (and only subcommands — flags
 * are omitted because most kobe subcommands define their own flags).
 */
import { TOP_LEVEL_SUBCOMMANDS } from "./subcommands.ts"

const COMPLETION_USAGE =
  "Usage: kobe completions <bash|zsh|fish>\n" +
  "\n" +
  "Generate a shell completion script for kobe and print it to stdout.\n" +
  "Redirect the output to the appropriate file for your shell.\n"

function generateBashCompletions(): string {
  const subcommands = TOP_LEVEL_SUBCOMMANDS.join(" ")

  return `# kobe bash completions\n# Source: kobe completions bash\n\n_kobe() {\n    local cur prev opts\n    COMPREPLY=()\n    cur="\${COMP_WORDS[COMP_CWORD]}"\n    prev="\${COMP_WORDS[COMP_CWORD-1]}"\n    opts="${subcommands}"\n\n    if [[ \${cur} == * ]] ; then\n        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )\n        return 0\n    fi\n}\ncomplete -F _kobe kobe\n`
}

function generateZshCompletions(): string {
  const subcommandsList = TOP_LEVEL_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")

  return `#compdef kobe\n# kobe zsh completions\n# Source: kobe completions zsh\n\n_kobe() {\n    local -a subcommands\n    subcommands=(${subcommandsList})\n\n    _arguments "1:subcommand:(\${subcommands})"\n}\n\n_kobe "$@"\n`
}

function generateFishCompletions(): string {
  const lines = TOP_LEVEL_SUBCOMMANDS.map((s) => `complete -c kobe -f -a ${s}`)
  return `# kobe fish completions\n# Source: kobe completions fish\n\n${lines.join("\n")}\n`
}

export async function runCompletionsSubcommand(rest: readonly string[]): Promise<void> {
  const shell = rest[0]

  if (shell === "--help" || shell === "-h" || shell === "help") {
    process.stdout.write(COMPLETION_USAGE)
    return
  }

  if (!shell || (shell !== "bash" && shell !== "zsh" && shell !== "fish")) {
    process.stderr.write(`kobe completions: unknown shell "${shell}"\n\n${COMPLETION_USAGE}`)
    process.exit(2)
  }

  let script: string
  if (shell === "bash") {
    script = generateBashCompletions()
  } else if (shell === "zsh") {
    script = generateZshCompletions()
  } else {
    script = generateFishCompletions()
  }

  process.stdout.write(script)
}
