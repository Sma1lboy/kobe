import { describe, expect, test } from "vitest"
import {
  defaultReleaseDialogVersion,
  releaseDialogTitle,
  releaseDialogVersionChoices,
} from "../../src/tui/component/update-dialog-helpers"
import type { ReleaseSummary, UpdateInfo } from "../../src/version"

const current: UpdateInfo = { current: "0.5.22", latest: "0.5.22", hasUpdate: false }
const update: UpdateInfo = { current: "0.5.22", latest: "0.5.23", hasUpdate: true }

describe("release dialog helpers", () => {
  test("titles the dialog by update state", () => {
    expect(releaseDialogTitle(current)).toBe("Release notes")
    expect(releaseDialogTitle(update)).toBe("Update available")
  })

  test("defaults to latest when an update exists and current otherwise", () => {
    expect(defaultReleaseDialogVersion(current)).toBe("0.5.22")
    expect(defaultReleaseDialogVersion(update)).toBe("0.5.23")
  })

  test("keeps latest/current first, then recent releases without duplicates", () => {
    const releases: ReleaseSummary[] = [
      { version: "0.5.23", url: "https://example.test/v0.5.23" },
      { version: "0.5.22", url: "https://example.test/v0.5.22" },
      { version: "0.5.21", url: "https://example.test/v0.5.21" },
    ]

    expect(releaseDialogVersionChoices(update, releases)).toEqual(["0.5.23", "0.5.22", "0.5.21"])
  })

  test("limits long release histories", () => {
    const releases = Array.from({ length: 12 }, (_, i) => ({
      version: `0.5.${23 - i}`,
      url: `https://example.test/v0.5.${23 - i}`,
    }))

    expect(releaseDialogVersionChoices(update, releases, 4)).toHaveLength(4)
  })
})
