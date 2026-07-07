import { describe, expect, test } from "vitest"
import type { ThemeJson } from "../../src/tui/context/theme-core"
import {
  BORDER_THEME_MARKER_OPTION,
  TMUX_CHROME_THEME_MARKER_OPTION,
  planBorderTheme,
  planTmuxChromeTheme,
  resolveBorderHexes,
  resolveTmuxChromeHexes,
} from "../../src/tui/lib/tmux-border-theme"

describe("resolveBorderHexes", () => {
  test("uses border + the focus-accent slot", () => {
    const theme: ThemeJson = {
      theme: { border: "#333333", primary: "#cc5544", info: "#3377cc", text: "#eeeeee" },
    }
    expect(resolveBorderHexes(theme, "primary")).toEqual({ border: "#333333", active: "#cc5544" })
    expect(resolveBorderHexes(theme, "info")).toEqual({ border: "#333333", active: "#3377cc" })
  })

  test("border falls back to text, active falls back to primary", () => {
    const theme: ThemeJson = { theme: { text: "#eeeeee", primary: "#cc5544" } }
    expect(resolveBorderHexes(theme, "info")).toEqual({ border: "#eeeeee", active: "#cc5544" })
  })

  test("an empty theme yields nulls (caller releases)", () => {
    expect(resolveBorderHexes({ theme: {} }, "primary")).toEqual({ border: null, active: null })
  })
})

describe("resolveTmuxChromeHexes", () => {
  test("derives border, statusbar, prompt, mode, and overlay colors from the active theme", () => {
    const theme: ThemeJson = {
      theme: {
        border: "#333333",
        primary: "#cc5544",
        info: "#3377cc",
        warning: "#ddaa33",
        text: "#eeeeee",
        textMuted: "#999999",
        background: "#111111",
        backgroundPanel: "#181818",
        backgroundElement: "#222222",
        backgroundMenu: "#2a2a2a",
        selectedListItemText: "#101010",
      },
    }

    expect(resolveTmuxChromeHexes(theme, "primary")).toEqual({
      border: "#333333",
      activeBorder: "#cc5544",
      statusBg: "#181818",
      statusFg: "#999999",
      statusMutedFg: "#999999",
      windowFg: "#999999",
      currentWindowBg: "#222222",
      currentWindowFg: "#cc5544",
      activityFg: "#3377cc",
      bellFg: "#ddaa33",
      messageBg: "#2a2a2a",
      messageFg: "#eeeeee",
      messageCommandFg: "#cc5544",
      modeBg: "#cc5544",
      modeFg: "#101010",
    })
  })

  test("an empty theme yields nulls so the caller releases owned tmux options", () => {
    expect(resolveTmuxChromeHexes({ theme: {} }, "primary")).toEqual({
      border: null,
      activeBorder: null,
      statusBg: null,
      statusFg: null,
      statusMutedFg: null,
      windowFg: null,
      currentWindowBg: null,
      currentWindowFg: null,
      activityFg: null,
      bellFg: null,
      messageBg: null,
      messageFg: null,
      messageCommandFg: null,
      modeBg: null,
      modeFg: null,
    })
  })
})

describe("planBorderTheme", () => {
  test("claims both options on a stock server and records ownership", () => {
    const commands = planBorderTheme({
      marker: "",
      currentBorder: "default",
      currentActive: "fg=green",
      borderHex: "#333333",
      activeHex: "#cc5544",
    })
    expect(commands).toEqual([
      ["set-option", "-gw", "pane-border-style", "fg=#333333"],
      ["set-option", "-gw", "pane-active-border-style", "fg=#cc5544"],
      ["set-option", "-g", BORDER_THEME_MARKER_OPTION, "border,active"],
    ])
  })

  test("overrides a tmux.conf-styled border too — kobe's socket, kobe's borders", () => {
    // oh-my-tmux's #303030 border is exactly the invisible-border bug;
    // the user's conf must not block the fix on the kobe socket.
    const commands = planBorderTheme({
      marker: "",
      currentBorder: "fg=#303030,bg=default",
      currentActive: "fg=#00afff,bg=default",
      borderHex: "#4c566a",
      activeHex: "#88c0d0",
    })
    expect(commands).toEqual([
      ["set-option", "-gw", "pane-border-style", "fg=#4c566a"],
      ["set-option", "-gw", "pane-active-border-style", "fg=#88c0d0"],
      ["set-option", "-g", BORDER_THEME_MARKER_OPTION, "border,active"],
    ])
  })

  test("re-applies over its own previous value on theme switch", () => {
    const commands = planBorderTheme({
      marker: "border,active",
      currentBorder: "fg=#333333",
      currentActive: "fg=#cc5544",
      borderHex: "#4c566a",
      activeHex: "#88c0d0",
    })
    expect(commands).toEqual([
      ["set-option", "-gw", "pane-border-style", "fg=#4c566a"],
      ["set-option", "-gw", "pane-active-border-style", "fg=#88c0d0"],
    ])
  })

  test("no-ops when the desired style is already applied", () => {
    const commands = planBorderTheme({
      marker: "border,active",
      currentBorder: "fg=#333333",
      currentActive: "fg=#cc5544",
      borderHex: "#333333",
      activeHex: "#cc5544",
    })
    expect(commands).toEqual([])
  })

  test("releases an owned option when its slot resolves to null", () => {
    const commands = planBorderTheme({
      marker: "border,active",
      currentBorder: "fg=#333333",
      currentActive: "fg=#cc5544",
      borderHex: null,
      activeHex: "#cc5544",
    })
    expect(commands).toEqual([
      ["set-option", "-gwu", "pane-border-style"],
      ["set-option", "-g", BORDER_THEME_MARKER_OPTION, "active"],
    ])
  })

  test("disabling (all-null hexes) unsets owned options and clears the marker", () => {
    const commands = planBorderTheme({
      marker: "border,active",
      currentBorder: "fg=#333333",
      currentActive: "fg=#cc5544",
      borderHex: null,
      activeHex: null,
    })
    expect(commands).toEqual([
      ["set-option", "-gwu", "pane-border-style"],
      ["set-option", "-gwu", "pane-active-border-style"],
      ["set-option", "-gu", BORDER_THEME_MARKER_OPTION],
    ])
  })

  test("never unsets options kobe does not own", () => {
    // Disabled on a server where kobe never wrote anything: the user's
    // (or stock) values must be left untouched, including the marker.
    const commands = planBorderTheme({
      marker: "",
      currentBorder: "fg=#303030,bg=default",
      currentActive: "fg=green",
      borderHex: null,
      activeHex: null,
    })
    expect(commands).toEqual([])
  })
})

describe("planTmuxChromeTheme", () => {
  const hexes = {
    border: "#333333",
    activeBorder: "#cc5544",
    statusBg: "#181818",
    statusFg: "#999999",
    statusMutedFg: "#999999",
    windowFg: "#999999",
    currentWindowBg: "#222222",
    currentWindowFg: "#cc5544",
    activityFg: "#3377cc",
    bellFg: "#ddaa33",
    messageBg: "#2a2a2a",
    messageFg: "#eeeeee",
    messageCommandFg: "#cc5544",
    modeBg: "#cc5544",
    modeFg: "#101010",
  }

  test("claims pane borders plus the full tmux status/window chrome on a stock server", () => {
    const commands = planTmuxChromeTheme({ marker: "", current: {}, hexes })
    expect(commands).toEqual([
      ["set-option", "-gw", "pane-border-style", "fg=#333333"],
      ["set-option", "-gw", "pane-active-border-style", "fg=#cc5544"],
      ["set-option", "-g", "status-style", "bg=#181818,fg=#999999"],
      ["set-option", "-g", "status-left-style", "bg=#181818,fg=#999999"],
      ["set-option", "-g", "status-right-style", "bg=#181818,fg=#999999"],
      ["set-option", "-g", "window-status-style", "bg=#181818,fg=#999999"],
      ["set-option", "-g", "window-status-current-style", "bg=#222222,fg=#cc5544,bold"],
      ["set-option", "-g", "window-status-activity-style", "bg=#181818,fg=#3377cc"],
      ["set-option", "-g", "window-status-bell-style", "bg=#181818,fg=#ddaa33,bold"],
      ["set-option", "-g", "window-status-last-style", "bg=#181818,fg=#999999"],
      ["set-option", "-g", "message-style", "bg=#2a2a2a,fg=#eeeeee"],
      ["set-option", "-g", "message-command-style", "bg=#2a2a2a,fg=#cc5544,bold"],
      ["set-option", "-g", "mode-style", "bg=#cc5544,fg=#101010"],
      ["set-option", "-g", "display-panes-colour", "#333333"],
      ["set-option", "-g", "display-panes-active-colour", "#cc5544"],
      [
        "set-option",
        "-g",
        TMUX_CHROME_THEME_MARKER_OPTION,
        "border,active,status,status-left,status-right,window,current-window,activity-window,bell-window,last-window,message,message-command,mode,display-panes,display-panes-active",
      ],
    ])
  })

  test("does not rewrite statusbar options that are already themed", () => {
    const marker =
      "border,active,status,status-left,status-right,window,current-window,activity-window,bell-window,last-window,message,message-command,mode,display-panes,display-panes-active"
    const commands = planTmuxChromeTheme({
      marker,
      current: {
        border: "fg=#333333",
        active: "fg=#cc5544",
        status: "bg=#181818,fg=#999999",
        "status-left": "bg=#181818,fg=#999999",
        "status-right": "bg=#181818,fg=#999999",
        window: "bg=#181818,fg=#999999",
        "current-window": "bg=#222222,fg=#cc5544,bold",
        "activity-window": "bg=#181818,fg=#3377cc",
        "bell-window": "bg=#181818,fg=#ddaa33,bold",
        "last-window": "bg=#181818,fg=#999999",
        message: "bg=#2a2a2a,fg=#eeeeee",
        "message-command": "bg=#2a2a2a,fg=#cc5544,bold",
        mode: "bg=#cc5544,fg=#101010",
        "display-panes": "#333333",
        "display-panes-active": "#cc5544",
      },
      hexes,
    })
    expect(commands).toEqual([])
  })

  test("disabling releases every tmux chrome option kobe owns", () => {
    const marker =
      "border,active,status,status-left,status-right,window,current-window,activity-window,bell-window,last-window,message,message-command,mode,display-panes,display-panes-active"
    const commands = planTmuxChromeTheme({
      marker,
      current: {},
      hexes: resolveTmuxChromeHexes({ theme: {} }, "primary"),
    })
    expect(commands).toEqual([
      ["set-option", "-gwu", "pane-border-style"],
      ["set-option", "-gwu", "pane-active-border-style"],
      ["set-option", "-gu", "status-style"],
      ["set-option", "-gu", "status-left-style"],
      ["set-option", "-gu", "status-right-style"],
      ["set-option", "-gu", "window-status-style"],
      ["set-option", "-gu", "window-status-current-style"],
      ["set-option", "-gu", "window-status-activity-style"],
      ["set-option", "-gu", "window-status-bell-style"],
      ["set-option", "-gu", "window-status-last-style"],
      ["set-option", "-gu", "message-style"],
      ["set-option", "-gu", "message-command-style"],
      ["set-option", "-gu", "mode-style"],
      ["set-option", "-gu", "display-panes-colour"],
      ["set-option", "-gu", "display-panes-active-colour"],
      ["set-option", "-gu", TMUX_CHROME_THEME_MARKER_OPTION],
    ])
  })
})
