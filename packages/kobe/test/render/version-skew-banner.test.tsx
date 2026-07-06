/**
 * VersionSkewBanner — daemon build-version skew strip (src/tui/component/version-skew-banner.tsx).
 * Ported from the render-track spike (spike-artifacts/tsx-render.spike.bun.test.tsx).
 */
import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { VersionSkewBanner } from "../../src/tui/component/version-skew-banner"
import { renderComponent } from "./harness"

describe("VersionSkewBanner", () => {
  it("renders both versions when stale", async () => {
    const [stale] = createSignal(true)
    const [daemonVersion] = createSignal<string | null>("0.7.3")
    const [width] = createSignal(80)

    const { frame } = await renderComponent(() => (
      <VersionSkewBanner stale={stale} daemonVersion={daemonVersion} clientVersion="0.7.4" width={width} />
    ))

    const text = await frame()
    expect(text).toContain("0.7.3")
    expect(text).toContain("0.7.4")
  })

  it("renders nothing when not stale", async () => {
    const [stale] = createSignal(false)
    const [daemonVersion] = createSignal<string | null>(null)
    const [width] = createSignal(80)

    const { frame } = await renderComponent(() => (
      <VersionSkewBanner stale={stale} daemonVersion={daemonVersion} clientVersion="0.7.4" width={width} />
    ))

    const text = await frame()
    expect(text).not.toContain("0.7.4")
  })
})
