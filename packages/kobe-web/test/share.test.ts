import { describe, expect, it } from "vitest"
import { taskDeepLink } from "../src/lib/share.ts"

/**
 * taskDeepLink is what "Copy link" puts on the clipboard — the URL a teammate
 * pastes to land on the task. Must match the `/task/$taskId` route, never emit
 * a double slash from a trailing-slash origin, and encode the id.
 */

describe("taskDeepLink", () => {
  it("builds <origin>/task/<id>", () => {
    expect(taskDeepLink("http://localhost:5173", "01ABC")).toBe(
      "http://localhost:5173/task/01ABC",
    )
  })

  it("normalizes a trailing slash on the origin (no //task)", () => {
    expect(taskDeepLink("http://localhost:5173/", "01ABC")).toBe(
      "http://localhost:5173/task/01ABC",
    )
    expect(taskDeepLink("http://host//", "x")).toBe("http://host/task/x")
  })

  it("url-encodes the task id", () => {
    expect(taskDeepLink("http://h", "a/b?c")).toBe(
      "http://h/task/a%2Fb%3Fc",
    )
  })

  it("works for a LAN origin (KOBE_WEB_HOST deploys)", () => {
    expect(taskDeepLink("http://192.168.1.5:5173", "t1")).toBe(
      "http://192.168.1.5:5173/task/t1",
    )
  })
})
