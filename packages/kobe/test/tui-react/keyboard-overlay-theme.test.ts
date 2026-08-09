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
