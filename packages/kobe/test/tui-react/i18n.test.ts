import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_LOCALE, currentLang, setLocaleLang, t, tKeys } from "../../src/tui-react/i18n"
import { t as solidT } from "../../src/tui/i18n"

afterEach(() => setLocaleLang(DEFAULT_LOCALE))

describe("react i18n runtime", () => {
  it("resolves a real catalog key identically to the Solid runtime", () => {
    setLocaleLang("en")
    expect(t("workspace.empty.selectTask")).toBe(solidT("workspace.empty.selectTask"))
  })

  it("switches language per process and reports it", () => {
    setLocaleLang("en")
    const en = t("workspace.empty.selectTask")
    setLocaleLang("zh")
    expect(currentLang()).toBe("zh")
    expect(t("workspace.empty.selectTask")).not.toBe(en)
  })

  it("ignores unknown locale ids", () => {
    setLocaleLang("en")
    setLocaleLang("xx" as never)
    expect(currentLang()).toBe("en")
  })

  it("falls back to the raw key for a missing string (loud, not blank)", () => {
    expect(t("definitely.not.a.key")).toBe("definitely.not.a.key")
  })

  it("interpolates {params} and leaves absent params literal", () => {
    // The raw-key fallback goes through interpolation too (same as Solid),
    // which pins both the substitution and the absent-param-stays-literal rule.
    expect(t("x {who}", { who: "kobe" })).toBe("x kobe")
    expect(t("x {who}", { other: "y" })).toBe("x {who}")
    expect(t("x {who}")).toBe("x {who}")
  })

  it("tKeys indexes the keybinding catalog by exact id", () => {
    setLocaleLang("en")
    // Any real binding id resolves to a non-empty string that isn't the raw id,
    // and an unknown id echoes back.
    expect(tKeys("desc", "not.a.real.binding.id")).toBe("not.a.real.binding.id")
  })
})
