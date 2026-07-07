/** @jsxImportSource @opentui/react */
/**
 * VersionSkewBanner — daemon build-version skew strip
 * (src/tui-react/component/version-skew-banner.tsx). React canon: props are
 * plain values, not accessors.
 */
import { describe, expect, it } from "bun:test"
import { VersionSkewBanner } from "../../src/tui-react/component/version-skew-banner"
import { renderComponent } from "./harness"

describe("VersionSkewBanner", () => {
  it("renders both versions when stale", async () => {
    const { frame } = await renderComponent(
      <VersionSkewBanner stale={true} daemonVersion="0.7.3" clientVersion="0.7.4" width={80} />,
    )
    const text = await frame()
    expect(text).toContain("0.7.3")
    expect(text).toContain("0.7.4")
  })

  it("renders nothing when not stale", async () => {
    const { frame } = await renderComponent(
      <VersionSkewBanner stale={false} daemonVersion={null} clientVersion="0.7.4" width={80} />,
    )
    const text = await frame()
    expect(text).not.toContain("0.7.4")
  })
})
