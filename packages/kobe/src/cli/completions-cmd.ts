/**
 * `kobe completions` — generate shell completion scripts.
 *
 * Usage:
 *   source <(kobe completions zsh)                 # zsh, one-off or in ~/.zshrc
 *   kobe completions zsh  > ~/.zsh/completions/_kobe   # zsh, fpath install
 *   kobe completions bash > ~/.bash_completion.d/kobe
 *   kobe completions fish > ~/.config/fish/completions/kobe.fish
 *
 * The zsh script works both ways: dropped into `$fpath` it is a normal
 * `#compdef` autoload file; sourced directly it registers itself via
 * `compdef` (the funcstack guard at the end tells the two apart).
 *
 * The generated scripts complete subcommands (and only subcommands — flags
 * are omitted because most kobe subcommands define their own flags).
 */
import { TOP_LEVEL_SUBCOMMANDS } from "./subcommands.ts"

const COMPLETION_USAGE = [
  "Usage: kobe completions <bash|zsh|fish>",
  "",
  "Generate a shell completion script for kobe and print it to stdout.",
  "",
  "Install:",
  "  zsh   source <(kobe completions zsh)     # one-off, or in ~/.zshrc after compinit",
  "        # or the fpath way:",
  "        #   kobe completions zsh > ~/.zsh/completions/_kobe",
  "        #   fpath=(~/.zsh/completions $fpath)   # in ~/.zshrc, BEFORE compinit",
  "        #   rm -f ~/.zcompdump && exec zsh      # rebuild the completion cache",
  "  bash  kobe completions bash > ~/.bash_completion.d/kobe   # source it from ~/.bashrc",
  "  fish  kobe completions fish > ~/.config/fish/completions/kobe.fish",
  "",
].join("\n")

function generateBashCompletions(): string {
  const subcommands = TOP_LEVEL_SUBCOMMANDS.join(" ")

  return [
    "# kobe bash completions",
    "# Source: kobe completions bash",
    "",
    "_kobe() {",
    "    local cur",
    "    COMPREPLY=()",
    '    cur="${COMP_WORDS[COMP_CWORD]}"',
    "    if [[ ${COMP_CWORD} -eq 1 ]]; then",
    `        COMPREPLY=( $(compgen -W "${subcommands}" -- \${cur}) )`,
    "    fi",
    "}",
    "complete -F _kobe kobe",
    "",
  ].join("\n")
}

function generateZshCompletions(): string {
  const subcommandsList = TOP_LEVEL_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")

  return [
    "#compdef kobe",
    "# kobe zsh completions",
    "# Source: kobe completions zsh",
    "",
    "_kobe() {",
    "    local -a subcommands",
    `    subcommands=(${subcommandsList})`,
    "",
    '    _arguments "1:subcommand:(${subcommands})"',
    "}",
    "",
    "# Autoloaded from $fpath -> run as the completion function;",
    "# sourced directly -> register with compdef instead.",
    'if [ "${funcstack[1]}" = "_kobe" ]; then',
    '    _kobe "$@"',
    "elif (( $+functions[compdef] )); then",
    "    compdef _kobe kobe",
    "fi",
    "",
  ].join("\n")
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
