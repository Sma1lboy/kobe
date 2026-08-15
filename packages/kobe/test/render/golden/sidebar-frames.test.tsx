/** @jsxImportSource @opentui/react */
/**
 * GOLDEN — what the sidebar actually LOOKS LIKE, locked frame by frame.
 *
 * The pure state matrix (`test/golden/sidebar-row-state.golden.txt`) locks what
 * each row decides. This locks what the terminal receives: real
 * `@opentui/react` mount, real Yoga layout, real char grid — one committed
 * `.frame.txt` per state of the rail.
 *
 * Why both, rather than one or the other: the two fail differently. A glyph
 * regression that the state matrix would catch could still be invisible if the
 * row never renders; a layout regression (indent lost, right-edge cluster
 * pushed off the rail, a row that stopped appearing) never reaches the state
 * machine at all. Substring assertions — `expect(text).toContain("feat/a")` —
 * catch neither, because they say nothing about the cells they don't name.
 *
 * After an INTENTIONAL change:
 *     KOBE_UPDATE_GOLDEN=1 bun run test:render
 * then read the diff. Every changed cell should be one you meant to change.
 */

import { afterAll, beforeAll, expect, test } from "bun:test"
import { DEFAULT_SPINNER_FRAMES } from "@/engine/spinner-frames"
import { currentLang, setLocaleLang } from "@/tui/i18n"
import { goldenPath, matchGolden } from "../../golden/golden-file"
import { renderComponent, settle } from "../harness"
import { SCENES, SCENE_HEIGHT, SCENE_WIDTH, type Scene } from "./sidebar-scenes"

/** Let opentui's mount, the tree's follow effect, and the layout pass settle
 *  before capturing — the same window every render test in this track uses. */
const SETTLE_MS = 90

/** Every glyph the spinner can be showing at capture time. A running row is
 *  genuinely animating, so its ONE glyph cell is replaced by `~` before the
 *  compare; the rest of the frame stays byte-exact. */
const SPINNER_GLYPHS = new Set(DEFAULT_SPINNER_FRAMES)

function maskSpinner(frame: string): string {
  let out = ""
  for (const ch of frame) out += SPINNER_GLYPHS.has(ch) ? "~" : ch
  return out
}

/** Frame the capture so trailing spaces survive review and the rail's right
 *  edge is visible as a column rather than implied. */
function frameDocument(scene: Scene, frame: string): string {
  // `captureCharFrame` ends with a newline; a trailing empty cell row would
  // otherwise be recorded as a bogus `||` line in every golden.
  const lines = frame.replace(/\n$/, "").split("\n")
  const body = lines.map((line) => `|${line}|`)
  return [
    `# sidebar frame: ${scene.name}`,
    `# ${scene.about}`,
    `# ${SCENE_WIDTH}x${SCENE_HEIGHT}${scene.keys ? `, keys: ${scene.keys.join(" ")}` : ""}${
      scene.animated ? ", spinner glyphs masked as ~" : ""
    }`,
    "# GENERATED — do not hand-edit. Regenerate: KOBE_UPDATE_GOLDEN=1 bun run test:render",
    ...body,
  ].join("\n")
}

// The subtitles and the recent-jump row come from `t()`, so a capture under a
// different active language would be a different document. The locale cell is
// process-wide and `bun test` runs this whole track in ONE process, so the
// restore belongs in afterAll — hanging it off an unrelated test's body let
// "en" leak into whatever ran next if that test was filtered or threw first.
let restoreLang = "en"
beforeAll(() => {
  restoreLang = currentLang()
  setLocaleLang("en")
})
afterAll(() => {
  setLocaleLang(restoreLang as Parameters<typeof setLocaleLang>[0])
})

for (const scene of SCENES) {
  test(`sidebar frame golden: ${scene.name}`, async () => {
    scene.setup()
    const { frame, mockInput } = await renderComponent(scene.element, {
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
    })
    await settle(SETTLE_MS)
    for (const key of scene.keys ?? []) {
      mockInput.typeText(key)
      await settle(SETTLE_MS)
    }
    const captured = scene.animated ? maskSpinner(await frame()) : await frame()
    const document = frameDocument(scene, captured)
    expect(matchGolden(goldenPath(import.meta.url, `${scene.name}.frame.txt`), document)).toBeNull()
  })
}

test("scene names are unique and every scene explains itself", () => {
  // A duplicated name would silently overwrite another scene's golden, and the
  // two tests would then take turns rewriting the same file.
  const names = SCENES.map((scene) => scene.name)
  expect(new Set(names).size).toBe(names.length)
  for (const scene of SCENES) expect(scene.about.length).toBeGreaterThan(20)
})
