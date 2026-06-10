import { describe, expect, test } from "vitest"
import type { ThemeJson } from "../../src/tui/context/theme"
import { BORDER_THEME_MARKER_OPTION, planBorderTheme, resolveBorderHexes } from "../../src/tui/lib/tmux-border-theme"

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
