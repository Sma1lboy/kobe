import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../..")

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
}

describe("keyboard overlay theme surfaces", () => {
  it("uses the readable dialog surface instead of transparent pane chrome", () => {
    const overlays = [
      source("src/tui-react/component/prefix-hud.tsx"),
      source("src/tui-react/component/keyboard-coach.tsx"),
    ].join("\n")

    expect(overlays).not.toContain("backgroundColor={theme.backgroundPanel}")
    expect(overlays.match(/backgroundColor=\{theme\.backgroundDialog\}/g)).toHaveLength(4)
  })
})
