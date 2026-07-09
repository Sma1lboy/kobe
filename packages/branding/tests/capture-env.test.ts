import { describe, expect, test } from "bun:test"
import {
  CAPTURE_TERMINAL_ENV,
  STARSHIP_PROMPT_CONFIG,
  captureEnv,
  isolatedPromptEnv,
  promptDefaultCommand,
  promptEnvEntries,
  promptEnvTmuxArgs,
  sanitizeCaptureEnv,
} from "../src/quicklook/capture-env"

describe("capture prompt isolation", () => {
  test("forces task shells through a deterministic shell with user init files disabled", () => {
    const env = isolatedPromptEnv("/tmp/capture-home")

    expect(env).toMatchObject({
      SHELL: "/bin/sh",
      PS1: "$ ",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      KOBE_TERMINAL_BACKEND: "bun-pty",
      ENV: "/dev/null",
      BASH_ENV: "/dev/null",
      ZDOTDIR: "/tmp/capture-home/zdotdir",
      STARSHIP_CONFIG: "/tmp/capture-home/starship.toml",
      STARSHIP_CACHE: "/tmp/capture-home/starship-cache",
    })
  })

  test("keeps the fallback starship prompt ASCII-only and disables runtime modules", () => {
    expect(STARSHIP_PROMPT_CONFIG).not.toMatch(/[^\x00-\x7F]/)
    expect(STARSHIP_PROMPT_CONFIG).toContain("[package]\ndisabled = true")
    expect(STARSHIP_PROMPT_CONFIG).toContain("[bun]\ndisabled = true")
    expect(STARSHIP_PROMPT_CONFIG).toContain('symbol = "git "')
  })

  test("passes prompt isolation through tmux environment arguments", () => {
    const args = promptEnvTmuxArgs(isolatedPromptEnv("/tmp/capture-home"))

    expect(args).toContain("SHELL=/bin/sh")
    expect(args).toContain("PS1=$ ")
    expect(args).toContain("TERM=xterm-256color")
    expect(args).toContain("COLORTERM=truecolor")
    expect(args).toContain("KOBE_TERMINAL_BACKEND=bun-pty")
    expect(args).toContain("ENV=/dev/null")
    expect(args).toContain("BASH_ENV=/dev/null")
    expect(args).toContain("ZDOTDIR=/tmp/capture-home/zdotdir")
    expect(args).toContain("STARSHIP_CONFIG=/tmp/capture-home/starship.toml")
    expect(args).toContain("STARSHIP_CACHE=/tmp/capture-home/starship-cache")
  })

  test("exposes prompt isolation as tmux server environment entries", () => {
    const entries = promptEnvEntries(isolatedPromptEnv("/tmp/capture-home"))

    expect(entries).toContainEqual(["SHELL", "/bin/sh"])
    expect(entries).toContainEqual(["PS1", "$ "])
    expect(entries).toContainEqual(["TERM", "xterm-256color"])
    expect(entries).toContainEqual(["COLORTERM", "truecolor"])
    expect(entries).toContainEqual(["ENV", "/dev/null"])
  })

  test("sanitizes color-affecting environment before capture", () => {
    const env = sanitizeCaptureEnv({
      PATH: "/usr/bin:/bin",
      TERM: "dumb",
      COLORTERM: "",
      NO_COLOR: "1",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "1",
      FORCE_COLOR: "0",
    })

    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.NO_COLOR).toBeUndefined()
    expect(env.CLICOLOR).toBeUndefined()
    expect(env.CLICOLOR_FORCE).toBeUndefined()
    expect(env.FORCE_COLOR).toBeUndefined()
    expect(env).toMatchObject(CAPTURE_TERMINAL_ENV)
  })

  test("builds full capture env from an injected base env and cleans it by default", () => {
    const env = captureEnv({
      baseEnv: {
        PATH: "/usr/bin:/bin",
        NO_COLOR: "1",
        CLICOLOR_FORCE: "1",
        KOBE_DAEMON_SOCKET_PATH: "/tmp/socket",
        KOBE_PTY_PID_PATH: "/tmp/pid",
        KEEP_ME: "yes",
      },
      promptEnv: isolatedPromptEnv("/tmp/capture-home"),
      path: "/tmp/capture-home/bin:/usr/bin:/bin",
      home: "/tmp/capture-home",
      innerSocket: "quicklook-inner",
      seconds: 8,
      warmupSeconds: 2,
    })

    expect(env.KEEP_ME).toBe("yes")
    expect(env.NO_COLOR).toBeUndefined()
    expect(env.CLICOLOR_FORCE).toBeUndefined()
    expect(env.KOBE_DAEMON_SOCKET_PATH).toBeUndefined()
    expect(env.KOBE_PTY_PID_PATH).toBeUndefined()
    expect(env).toMatchObject({
      ...CAPTURE_TERMINAL_ENV,
      PATH: "/tmp/capture-home/bin:/usr/bin:/bin",
      KOBE_HOME_DIR: "/tmp/capture-home",
      KOBE_TMUX_SOCKET: "quicklook-inner",
      KOBE_DAEMON_WEB_PORT: "off",
      KOBE_DAEMON_IDLE_GRACE_MS: "40000",
      SHELL: "/bin/sh",
      PS1: "$ ",
    })
  })

  test("cleans process.env by default when no base env is injected", () => {
    const previousNoColor = process.env.NO_COLOR
    const previousTerm = process.env.TERM
    try {
      process.env.NO_COLOR = "1"
      process.env.TERM = "dumb"

      const env = captureEnv({
        promptEnv: isolatedPromptEnv("/tmp/capture-home"),
        path: "/tmp/capture-home/bin:/usr/bin:/bin",
        home: "/tmp/capture-home",
        innerSocket: "quicklook-inner",
        seconds: 1,
        warmupSeconds: 1,
      })

      expect(env.NO_COLOR).toBeUndefined()
      expect(env.TERM).toBe("xterm-256color")
      expect(env.COLORTERM).toBe("truecolor")
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
      if (previousTerm === undefined) delete process.env.TERM
      else process.env.TERM = previousTerm
    }
  })

  test("builds a non-login default command for tmux shell panes", () => {
    const command = promptDefaultCommand(isolatedPromptEnv("/tmp/capture-home"), {
      home: "/tmp/capture-home",
      path: "/usr/bin:/bin",
    })

    expect(command).toContain("env -i")
    expect(command).toContain("HOME=/tmp/capture-home")
    expect(command).toContain("TERM=xterm-256color")
    expect(command).toContain("COLORTERM=truecolor")
    expect(command).toContain("ENV=/dev/null")
    expect(command).toContain("BASH_ENV=/dev/null")
    expect(command).toContain("PS1='$ '")
    expect(command.endsWith(" /bin/sh")).toBe(true)
  })
})
