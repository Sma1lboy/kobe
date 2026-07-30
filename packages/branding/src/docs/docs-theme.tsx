// Docs illustration theme — the kobe-landing warm-paper palette
// (packages/kobe-landing/tokens.css), flat hairlines, JetBrains Mono only.
// Used by the Docs*.tsx still compositions rendered into ../../docs/assets/.

import { loadFont } from "@remotion/google-fonts/JetBrainsMono"

loadFont("normal", { weights: ["400", "500", "700"], subsets: ["latin"] })

export const T = {
  paper: "oklch(17.5% 0.003 100)",
  paper2: "oklch(20% 0.004 95)",
  well: "oklch(14% 0.003 95)",
  ink: "oklch(92.5% 0.011 95)",
  ink2: "oklch(85.7% 0.014 95)",
  muted: "oklch(69.5% 0.015 90)",
  faint: "oklch(60.5% 0.014 90)",
  dim: "oklch(49.5% 0.014 90)",
  rule: "oklch(25.7% 0.01 85)",
  rule2: "oklch(29% 0.011 85)",
  accent: "oklch(65% 0.107 41)",
  accentSoft: "oklch(83.5% 0.045 45)",
  accentLine: "oklch(65% 0.107 41 / 0.45)",
  ok: "oklch(78.5% 0.1 136)",
} as const

export const MONO = '"JetBrains Mono", ui-monospace, monospace'

/** Inset hairline frame so the figure reads as a deliberate card on light themes too. */
export const InsetFrame: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 28,
      border: `1px solid ${T.rule}`,
      borderRadius: 18,
      pointerEvents: "none",
    }}
  />
)

/** Small dim uppercase mono label, the shared caption grammar. */
export const KeyLabel: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = T.dim,
}) => (
  <div style={{ fontSize: 19, letterSpacing: 3, textTransform: "uppercase", color }}>{children}</div>
)
