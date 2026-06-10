import { describe, expect, it } from "vitest"
import { parseRemoteFlags } from "../../src/cli/add-remote.ts"

describe("parseRemoteFlags", () => {
  it("parses host/user/path/port and key with a path", () => {
    const f = parseRemoteFlags([
      "--host",
      "box",
      "--user",
      "dev",
      "--path",
      "/srv/work",
      "--port",
      "2222",
      "--key",
      "/home/dev/.ssh/id",
    ])
    expect(f).toMatchObject({ host: "box", user: "dev", path: "/srv/work", port: 2222 })
    expect(f.key).toEqual({ present: true, path: "/home/dev/.ssh/id" })
    expect(f.password).toBeUndefined()
  })

  it("treats a bare --key (no following path) as agent auth", () => {
    const f = parseRemoteFlags(["--host", "box", "--user", "dev", "--path", "/srv", "--key"])
    expect(f.key).toEqual({ present: true })
  })

  it("does not consume the next flag as the key path", () => {
    const f = parseRemoteFlags(["--key", "--password"])
    expect(f.key).toEqual({ present: true })
    expect(f.password).toBe(true)
  })

  it("parses --password as a flag", () => {
    const f = parseRemoteFlags(["--host", "box", "--user", "dev", "--path", "/srv", "--password"])
    expect(f.password).toBe(true)
    expect(f.key).toBeUndefined()
  })
})
