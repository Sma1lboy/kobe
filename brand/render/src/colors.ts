// Claude brand palette — kobe's default theme.
// Ported from ashwingopalsamy/claude-code-theme's brandTokens so the rendered
// brand assets stay coherent with the running TUI (terracotta accent on warm
// neutrals). Slot names are kept generic (`blue`, `cyan`, …) for backward
// compatibility with existing logo components — values are mapped to the
// closest Claude-brand equivalent, with `blue` taking the terracotta accent
// because that is the brand-defining hue used as the wordmark / halo.

export const colors = {
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

export const monoStack =
  '"JetBrains Mono", "IBM Plex Mono", "SF Mono", "Menlo", "Consolas", ui-monospace, monospace'
