import { afterEach, describe, expect, it, vi } from "vitest"
import { ptyUrl } from "../src/lib/terminal.ts"


function withLocation(loc: Partial<Location>): void {
  vi.stubGlobal("location", {
    protocol: "http:",
    hostname: "localhost",
    port: "5173",
    ...loc,
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("ptyUrl", () => {
  it("targets the pty sidecar at port + 2 over ws on http", () => {
    withLocation({ protocol: "http:", hostname: "localhost", port: "5173" })
    const url = ptyUrl("tab1", "task1", "engine", 80, 24)
    expect(url.startsWith("ws://localhost:5175/pty?")).toBe(true)
  })

  it("uses wss on https", () => {
    withLocation({ protocol: "https:", hostname: "kobe.local", port: "8443" })
    expect(ptyUrl("t", "k", "shell", 80, 24)).toMatch(
      /^wss:\/\/kobe\.local:8445\/pty\?/,
    )
  })

  it("carries tab/taskId/mode/cols/rows as query params", () => {
    withLocation({ port: "5173" })
    const q = new URL(ptyUrl("tab-x", "task-y", "engine", 120, 30)).searchParams
    expect(q.get("tab")).toBe("tab-x")
    expect(q.get("taskId")).toBe("task-y")
    expect(q.get("mode")).toBe("engine")
    expect(q.get("cols")).toBe("120")
    expect(q.get("rows")).toBe("30")
  })

  it("falls back to 5175 when the port is unparseable", () => {
    withLocation({ port: "" })
    expect(ptyUrl("t", "k", "shell", 80, 24)).toContain(":5175/")
  })
})
