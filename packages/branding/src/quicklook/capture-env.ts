export type PromptIsolationEnv = {
  SHELL: string
  PS1: string
  TERM: string
  COLORTERM: string
  KOBE_TERMINAL_BACKEND: string
  ENV: string
  BASH_ENV: string
  ZDOTDIR: string
  STARSHIP_CONFIG: string
  STARSHIP_CACHE: string
}

type EnvRecord = Record<string, string | undefined>

export type CaptureEnvOptions = {
  baseEnv?: EnvRecord
  promptEnv: PromptIsolationEnv
  path: string
  home: string
  innerSocket: string
  seconds: number
  warmupSeconds: number
}

export const STARSHIP_PROMPT_CONFIG = [
  'format = "$directory$git_branch$git_status$character"',
  "add_newline = false",
  "",
  "[git_branch]",
  'symbol = "git "',
  "",
  "[character]",
  'success_symbol = "> "',
  'error_symbol = "> "',
  "",
  "[package]",
  "disabled = true",
  "",
  "[bun]",
  "disabled = true",
  "",
].join("\n")

const PROMPT_ENV_KEYS = [
  "SHELL",
  "PS1",
  "TERM",
  "COLORTERM",
  "KOBE_TERMINAL_BACKEND",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
  "STARSHIP_CONFIG",
  "STARSHIP_CACHE",
] as const

export const CAPTURE_TERMINAL_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
} as const

const COLOR_CONTROL_ENV_KEYS = [
  "NO_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "FORCE_COLOR",
] as const

const KOBE_PROCESS_ENV_KEYS = [
  "KOBE_DAEMON_SOCKET_PATH",
  "KOBE_DAEMON_PID_PATH",
  "KOBE_PTY_SOCKET_PATH",
  "KOBE_PTY_PID_PATH",
] as const

export function sanitizeCaptureEnv<T extends EnvRecord>(base: T): EnvRecord {
  const env: EnvRecord = { ...base }
  for (const key of COLOR_CONTROL_ENV_KEYS) delete env[key]
  return {
    ...env,
    ...CAPTURE_TERMINAL_ENV,
  }
}

export function captureEnv({
  baseEnv = process.env,
  promptEnv,
  path,
  home,
  innerSocket,
  seconds,
  warmupSeconds,
}: CaptureEnvOptions): EnvRecord {
  const env = sanitizeCaptureEnv(baseEnv)
  for (const key of KOBE_PROCESS_ENV_KEYS) delete env[key]
  return {
    ...env,
    ...promptEnv,
    PATH: path,
    KOBE_HOME_DIR: home,
    KOBE_TMUX_SOCKET: innerSocket,
    KOBE_DAEMON_WEB_PORT: "off",
    KOBE_DAEMON_IDLE_GRACE_MS: String(Math.ceil((seconds + warmupSeconds + 30) * 1000)),
  }
}

export function isolatedPromptEnv(home: string): PromptIsolationEnv {
  return {
    SHELL: "/bin/sh",
    PS1: "$ ",
    ...CAPTURE_TERMINAL_ENV,
    KOBE_TERMINAL_BACKEND: "bun-pty",
    ENV: "/dev/null",
    BASH_ENV: "/dev/null",
    ZDOTDIR: `${home}/zdotdir`,
    STARSHIP_CONFIG: `${home}/starship.toml`,
    STARSHIP_CACHE: `${home}/starship-cache`,
  }
}

export function promptEnvEntries(env: PromptIsolationEnv): Array<[keyof PromptIsolationEnv, string]> {
  return PROMPT_ENV_KEYS.map((key) => [key, env[key]])
}

export function promptEnvTmuxArgs(env: PromptIsolationEnv): string[] {
  return promptEnvEntries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`])
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function promptDefaultCommand(
  env: PromptIsolationEnv,
  opts: { home: string; path: string },
): string {
  const entries: Array<[string, string]> = [
    ["PATH", opts.path],
    ["HOME", opts.home],
    ...promptEnvEntries(env),
  ]
  return [
    "env",
    "-i",
    ...entries.map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(env.SHELL),
  ].join(" ")
}
