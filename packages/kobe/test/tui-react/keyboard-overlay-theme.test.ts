import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../..")

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
}

describe("which-key overlay theme surface", () => {
  it("uses the readable dialog surface instead of transparent pane chrome", () => {
    const overlay = source("src/tui-react/component/prefix-hud.tsx")

    expect(overlay).not.toContain("backgroundColor={theme.backgroundPanel}")
    expect(overlay.match(/backgroundColor=\{theme\.backgroundDialog\}/g)).toHaveLength(3)
  })
})

describe("keyboard hint theme surface", () => {
  it("stays text-only on the ambient background so transparent themes keep it readable", () => {
    // The hints deliberately paint NO background of their own: over a normal
    // theme they sit on the frame/panel fill, over a transparent theme the
    // host terminal shows through and muted fg text stays legible. Painting
    // an opaque panel color here would regress the transparent mode #388
    // fixed for the which-key overlay.
    const hints = source("src/tui-react/component/keyboard-hints.tsx")
    expect(hints).not.toContain("backgroundColor=")
    expect(hints.match(/fg=\{theme\.textMuted\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
