// kobe brand palettes.
// `dark` — the original Claude-brand port (terracotta accent on warm neutrals),
// coherent with the running TUI's default theme.
// `light` — porcelain daylight palette mapped from the light landing page
// (marketing/kobe-landing-light): warm porcelain paper, espresso ink,
// terracotta accent, morning-sky secondary.
// Slot names stay generic (`blue`, `cyan`, …) for backward compatibility with
// the logo components; `blue` carries the terracotta accent in both themes.
//
// Select with KOBE_BRAND_THEME=dark|light (default: light, matching the
// current landing direction).

const dark = {
  bg: "#141413", // background.dark
  bgSoft: "#1A1917", // background.darkRaised — also the GlyphK card body
  panel: "#2B2A27", // background.darkInset
  border: "#3A3835", // tinted neutral between inset and smoke
  fg: "#EAE7DF", // foreground.dark (paper)
  muted: "#A9A39A", // neutral.smoke / foreground.darkMuted
  blue: "#CC785C", // accent (terracotta) — brand-defining hue
  cyan: "#D4967E", // interactive.dark — softened terracotta
  green: "#9ACA86", // success.dark
  magenta: "#9B87F5", // highlights.violet
  yellow: "#E8C96B", // warning.dark
  orange: "#D97757", // secondary
  red: "#D47563", // error.dark
} as const

const light: typeof dark = {
  bg: "#F6F3EC", // --paper · warm porcelain
  bgSoft: "#FDFCF9", // --surface
  panel: "#EFEAE0", // inset tint
  border: "#DFD8CB", // --line
  fg: "#3B322A", // --ink · warm espresso
  muted: "#7C7266", // --muted
  blue: "#C46B48", // --accent · terracotta, deepened for light contrast
  cyan: "#A85E3E", // interactive — deeper terracotta so it reads on paper
  green: "#5F8C49", // success, darkened for light bg
  magenta: "#7C68CE", // violet highlight
  yellow: "#B08A2F", // warning
  orange: "#C9714F", // secondary
  red: "#B65742", // error
}

export const palettes = { dark, light } as const

export const colors = process.env.KOBE_BRAND_THEME === "dark" ? dark : light

export const monoStack =
  '"JetBrains Mono", "IBM Plex Mono", "SF Mono", "Menlo", "Consolas", ui-monospace, monospace'
