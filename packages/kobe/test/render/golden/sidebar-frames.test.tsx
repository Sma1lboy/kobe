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
import { engineEntry } from "@/engine/registry"
import { DEFAULT_SPINNER_FRAMES } from "@/engine/spinner-frames"
import { currentLang, setLocaleLang } from "@/tui/i18n"
import { BUILTIN_VENDORS } from "@/types/vendor"
import { REGENERATE_RENDER, goldenPath, matchGolden } from "../../golden/golden-file"
import { renderComponent, settle } from "../harness"
import { SCENES, SCENE_HEIGHT, SCENE_WIDTH, type Scene } from "./sidebar-scenes"

/** One poll step while waiting for the frame to settle or the spinner to tick.
 *  The spinner runs at 10Hz, so this samples several times per frame. */
const POLL_MS = 25

/** Ceiling on any wait below. Generous: it only bounds the FAILURE path, since
 *  every wait returns as soon as its condition holds. */
const POLL_TIMEOUT_MS = 4_000

/**
 * Every glyph any engine's spinner can show, taken from the REGISTRY rather
 * than from two hard-coded frame sets — engines own their frames (CLAUDE.md
 * "Engine-owned UI data"), so a vendor that ships brand frames would otherwise
 * capture an unmasked, per-run-varying glyph and flake the animated goldens.
 */
const SPINNER_GLYPHS = new Set<string>(
  [...BUILTIN_VENDORS].flatMap((vendor) => [...(engineEntry(vendor).spinnerFrames ?? DEFAULT_SPINNER_FRAMES)]),
)

/**
 * Blank out whichever spinner frame the capture happened to catch.
 *
 * Masking is ONLY about which frame the clock landed on — it is deliberately
 * NOT the proof that the row animates. It cannot be: claude's frame set opens
 * on `·`, so a spinner frozen at frame 0 masks to the same `~` a live one does.
 * `waitForSpinnerTick` below is what proves liveness; this just removes the
 * nondeterminism afterwards.
 *
 * The mask is by glyph identity across the whole frame, so an animated scene
 * must contain no NON-agent tab — its plain `·` is in this set and would be
 * masked too. `assertNoMaskCollision` enforces that rather than trusting it.
 */
function maskSpinner(frame: string): string {
  let out = ""
  for (const ch of frame) out += SPINNER_GLYPHS.has(ch) ? "~" : ch
  return out
}

/** Poll until `read` returns the same value twice running — the layout has
 *  stopped moving. A fixed sleep encodes one runner's speed; these are
 *  byte-exact compares, so a half-laid-out capture is a red gate that
 *  reproduces nowhere (docs/HARNESS.md "Poll, never sleep-then-assert"). */
async function waitForStable(read: () => Promise<string>): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let previous = await read()
  while (Date.now() < deadline) {
    await settle(POLL_MS)
    const next = await read()
    if (next === previous) return next
    previous = next
  }
  return previous
}

/**
 * Poll until the frame actually CHANGES — the animated scenes' liveness proof.
 *
 * Without this the running goldens are vacuous: mask the spinner cell and a
 * dead spinner is byte-identical to a live one, so the 10Hz store could stop
 * scheduling entirely and `tab-running` / `tab-running-sibling` — the only
 * render coverage of the running state — would both stay green.
 */
async function waitForSpinnerTick(read: () => Promise<string>): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  const first = await read()
  while (Date.now() < deadline) {
    await settle(POLL_MS)
    const next = await read()
    if (next !== first) return next
  }
  throw new Error(
    "spinner never advanced: the frame was byte-identical for the whole poll window, so this row is not animating. " +
      "A masked golden cannot see this — that is why the wait exists.",
  )
}

/** An animated scene's mask must not swallow a cell that is NOT the spinner. */
function assertNoMaskCollision(scene: Scene, live: string, masked: string): void {
  // Exactly one cell may differ between the raw capture and the masked one per
  // animating row. More than the scene's animating rows means the mask ate a
  // `·` that belonged to a non-agent tab (or some other borrowed glyph).
  const maskedCells = [...live].filter((ch, i) => ch !== masked[i]).length
  expect({ scene: scene.name, maskedCells }).toEqual({ scene: scene.name, maskedCells: 1 })
}

/**
 * Frame the capture so trailing spaces survive review and the rail's right
 * edge is visible as a column rather than implied.
 *
 * Deliberately NOT included: `scene.about`. Prose inside a byte-compared file
 * means editing a comment reddens every frame test with a `golden mismatch`
 * indistinguishable from a real layout regression — and the natural response to
 * that is a blanket regenerate, which would bless any genuine cell drift
 * sitting in the same branch. The geometry line stays: 30x22 and the keys typed
 * ARE behavior, and a change to either should move the golden.
 */
function frameDocument(scene: Scene, frame: string): string {
  // `captureCharFrame` ends with a newline; a trailing empty cell row would
  // otherwise be recorded as a bogus `||` line in every golden.
  const lines = frame.replace(/\n$/, "").split("\n")
  const body = lines.map((line) => `|${line}|`)
  return [
    `# sidebar frame: ${scene.name}`,
    `# ${SCENE_WIDTH}x${SCENE_HEIGHT}${scene.keys ? `, keys: ${scene.keys.join(" ")}` : ""}${
      scene.animated ? ", spinner cell masked as ~" : ""
    }`,
    "# GENERATED — do not hand-edit. Why this scene exists: see sidebar-scenes.tsx.",
    `# Regenerate: ${REGENERATE_RENDER}`,
    ...body,
  ].join("\n")
}

/**
 * Checked at MODULE LOAD, before any scene test can write.
 *
 * As a test it ran after the per-scene tests, so under `KOBE_UPDATE_GOLDEN=1` a
 * duplicated name had already overwritten the other scene's committed fixture
 * by the time it failed — the exact hazard it exists to prevent.
 */
const names = SCENES.map((scene) => scene.name)
if (new Set(names).size !== names.length) {
  const dupes = names.filter((name, i) => names.indexOf(name) !== i)
  throw new Error(`duplicate scene name(s): ${[...new Set(dupes)].join(", ")} — each scene owns one golden file`)
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
    await waitForStable(frame)
    for (const key of scene.keys ?? []) {
      mockInput.typeText(key)
      await waitForStable(frame)
    }

    let captured: string
    if (scene.animated) {
      // Liveness first (throws if the row is frozen), then mask the frame it
      // left us on so the compare is deterministic.
      const live = await waitForSpinnerTick(frame)
      captured = maskSpinner(live)
      assertNoMaskCollision(scene, live, captured)
    } else {
      captured = await frame()
    }

    const document = frameDocument(scene, captured)
    expect(matchGolden(goldenPath(import.meta.url, `${scene.name}.frame.txt`), document)).toBeNull()
  })
}

test("every scene explains itself", () => {
  // Uniqueness is enforced at module load above — this is the remaining
  // documentation floor, and it is safe to run after the writes.
  for (const scene of SCENES) expect(scene.about.length).toBeGreaterThan(20)
})
