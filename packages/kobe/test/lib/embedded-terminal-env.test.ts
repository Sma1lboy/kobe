import { embeddedTerminalEnv } from "@sma1lboy/kobe-daemon/daemon/pty-env"
import { describe, expect, it } from "vitest"

describe("embeddedTerminalEnv", () => {
  it("removes the outer terminal identity while retaining capabilities and overrides", () => {
    const base = {
      TERM_PROGRAM: "iTerm.app",
      TERM_PROGRAM_VERSION: "3.6.11",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/test",
    }

    const result = embeddedTerminalEnv(base, { KOBE_TERMINAL_PTY: "1" })

    expect(result).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/test",
      KOBE_TERMINAL_PTY: "1",
    })
    expect(base.TERM_PROGRAM).toBe("iTerm.app")
  })

  it("removes fallback identity channels apps use once TERM_PROGRAM is gone", () => {
    // claude-code's layered detection: with TERM_PROGRAM stripped it still
    // resolved iTerm2 from these and kept redrawing in iTerm's dialect.
    const result = embeddedTerminalEnv({
      LC_TERMINAL: "iTerm2",
      LC_TERMINAL_VERSION: "3.5.11",
      ITERM_SESSION_ID: "w0t0p0:UUID",
      ITERM_PROFILE: "Default",
      TERM_SESSION_ID: "w0t0p0:UUID",
      TERM_FEATURES: "T3LrMSc7UUw9Ts3BFGsSyHNoSxF",
      __CFBundleIdentifier: "com.googlecode.iterm2",
      HOME: "/home/test",
    })

    expect(result).toEqual({ HOME: "/home/test" })
  })

  it("removes every emulator family's identity variables and multiplexer markers", () => {
    const result = embeddedTerminalEnv({
      KITTY_WINDOW_ID: "1",
      KITTY_PID: "42",
      GHOSTTY_RESOURCES_DIR: "/opt/ghostty",
      WEZTERM_PANE: "0",
      ALACRITTY_WINDOW_ID: "7",
      KONSOLE_VERSION: "230800",
      VTE_VERSION: "7600",
      WT_SESSION: "uuid",
      TMUX: "/tmp/tmux-501/default,123,0",
      TMUX_PANE: "%1",
      ZELLIJ: "0",
      ZELLIJ_SESSION_NAME: "main",
      STY: "1234.pts-0.host",
      PATH: "/usr/bin",
    })

    expect(result).toEqual({ PATH: "/usr/bin" })
  })
})
