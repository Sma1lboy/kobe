import type { ProductCliName } from "../product.ts"
import { activeCliName } from "./rename-compat.ts"
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

function completionUsage(cliName: ProductCliName): string {
  return [
    `Usage: ${cliName} completions <bash|zsh|fish>`,
    "",
    `Generate a shell completion script for ${cliName} and print it to stdout.`,
    "",
    "Install:",
    `  zsh   source <(${cliName} completions zsh)     # one-off, or in ~/.zshrc after compinit`,
    "        # or the fpath way:",
    `        #   ${cliName} completions zsh > ~/.zsh/completions/_${cliName}`,
    "        #   fpath=(~/.zsh/completions $fpath)   # in ~/.zshrc, BEFORE compinit",
    "        #   rm -f ~/.zcompdump && exec zsh      # rebuild the completion cache",
    `  bash  ${cliName} completions bash > ~/.bash_completion.d/${cliName}   # source it from ~/.bashrc`,
    `  fish  ${cliName} completions fish > ~/.config/fish/completions/${cliName}.fish`,
    "",
  ].join("\n")
}

function generateBashCompletions(cliName: ProductCliName): string {
  const subcommands = TOP_LEVEL_SUBCOMMANDS.join(" ")
  const fn = `_${cliName}`

  return [
    `# ${cliName} bash completions`,
    `# Source: ${cliName} completions bash`,
    "",
    `${fn}() {`,
    "    local cur",
    "    COMPREPLY=()",
    '    cur="${COMP_WORDS[COMP_CWORD]}"',
    "    if [[ ${COMP_CWORD} -eq 1 ]]; then",
    `        COMPREPLY=( $(compgen -W "${subcommands}" -- \${cur}) )`,
    "    fi",
    "}",
    `complete -F ${fn} ${cliName}`,
    "",
  ].join("\n")
}

function generateZshCompletions(cliName: ProductCliName): string {
  const subcommandsList = TOP_LEVEL_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")
  const fn = `_${cliName}`

  return [
    `#compdef ${cliName}`,
    `# ${cliName} zsh completions`,
    `# Source: ${cliName} completions zsh`,
    "",
    `${fn}() {`,
    "    local -a subcommands",
    `    subcommands=(${subcommandsList})`,
    "",
    '    _arguments "1:subcommand:(${subcommands})"',
    "}",
    "",
    "# Autoloaded from $fpath -> run as the completion function;",
    "# sourced directly -> register with compdef instead.",
    `if [ "\${funcstack[1]}" = "${fn}" ]; then`,
    `    ${fn} "$@"`,
    "elif (( $+functions[compdef] )); then",
    `    compdef ${fn} ${cliName}`,
    "fi",
    "",
  ].join("\n")
}

function generateFishCompletions(cliName: ProductCliName): string {
  const lines = TOP_LEVEL_SUBCOMMANDS.map((s) => `complete -c ${cliName} -f -a ${s}`)
  return `# ${cliName} fish completions\n# Source: ${cliName} completions fish\n\n${lines.join("\n")}\n`
}

export async function runCompletionsSubcommand(
  rest: readonly string[],
  cliName: ProductCliName = activeCliName(),
): Promise<void> {
  const shell = rest[0]
  const usage = completionUsage(cliName)

  if (shell === "--help" || shell === "-h" || shell === "help") {
    process.stdout.write(usage)
    return
  }

  if (!shell || (shell !== "bash" && shell !== "zsh" && shell !== "fish")) {
    process.stderr.write(`${cliName} completions: unknown shell "${shell}"\n\n${usage}`)
    process.exit(2)
  }

  let script: string
  if (shell === "bash") {
    script = generateBashCompletions(cliName)
  } else if (shell === "zsh") {
    script = generateZshCompletions(cliName)
  } else {
    script = generateFishCompletions(cliName)
  }

  process.stdout.write(script)
}
