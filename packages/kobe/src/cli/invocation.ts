import { fileURLToPath } from "node:url"

export function kobeCliInvocation(): string[] {
  const isBuilt = import.meta.url.endsWith(".js")
  if (isBuilt) return ["kobe"]
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url))
  const preload = fileURLToPath(import.meta.resolve("@opentui/solid/preload"))
  return [process.execPath, "--preload", preload, "--conditions=browser", entry]
}

export function kobeHookInvocation(): string[] {
  if (import.meta.url.endsWith(".js")) return ["kobe"]
  if (Bun.which("kobe")) return ["kobe"]
  return kobeCliInvocation()
}
