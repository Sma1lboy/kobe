/**
 * Type-level tests for src/types/engine.ts.
 *
 * These do not run as runtime tests; they are checked by `tsc --noEmit`
 * (`bun run typecheck`) because they live under `test/**` which is in
 * tsconfig include. Vitest 2.x will additionally pick them up if/when
 * `typecheck.enabled` is turned on in `vitest.config.ts`. Either way,
 * the type-level assertions are the source of truth for the contract.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { AIEngine, EngineEvent, Message, SessionHandle, SpawnOpts } from "../../src/types/engine.ts"

describe("EngineEvent", () => {
  it("is a discriminated union keyed on `type`", () => {
    type Tags = EngineEvent["type"]
    expectTypeOf<Tags>().toEqualTypeOf<"assistant.delta" | "tool.start" | "tool.result" | "usage" | "done" | "error">()
  })

  it("narrows correctly per discriminator", () => {
    const ev = null as unknown as EngineEvent
    if (ev.type === "assistant.delta") {
      expectTypeOf(ev).toEqualTypeOf<{ readonly type: "assistant.delta"; readonly text: string }>()
    } else if (ev.type === "tool.start") {
      expectTypeOf(ev.input).toEqualTypeOf<unknown>()
      expectTypeOf(ev.name).toEqualTypeOf<string>()
    } else if (ev.type === "tool.result") {
      expectTypeOf(ev.output).toEqualTypeOf<unknown>()
    } else if (ev.type === "usage") {
      expectTypeOf(ev.input_tokens).toEqualTypeOf<number>()
      expectTypeOf(ev.output_tokens).toEqualTypeOf<number>()
    } else if (ev.type === "done") {
      expectTypeOf(ev).toEqualTypeOf<{ readonly type: "done" }>()
    } else if (ev.type === "error") {
      expectTypeOf(ev.message).toEqualTypeOf<string>()
    }
  })

  it("rejects excess properties on a single variant", () => {
    // Excess-property check: object literal with an unknown field on
    // `done` must fail to assign to EngineEvent.
    // @ts-expect-error — `extra` is not part of the `done` variant
    const _bad: EngineEvent = { type: "done", extra: 1 }
    void _bad
  })

  it("rejects mixing fields across variants", () => {
    // @ts-expect-error — `text` belongs to assistant.delta, not done
    const _bad: EngineEvent = { type: "done", text: "hi" }
    void _bad
  })
})

describe("SessionHandle", () => {
  it("has the documented required fields and they are readonly", () => {
    expectTypeOf<SessionHandle>().toMatchTypeOf<{ readonly sessionId: string; readonly cwd: string }>()
  })
})

describe("SpawnOpts", () => {
  it("makes every field optional", () => {
    const _empty: SpawnOpts = {}
    void _empty
  })

  it("accepts the documented option shape", () => {
    const _full: SpawnOpts = {
      model: "opus-4.6",
      env: { FOO: "bar" },
      timeoutMs: 60_000,
      systemPrompt: "be terse",
    }
    void _full
  })

  it("rejects unknown options", () => {
    // @ts-expect-error — `garbage` is not a SpawnOpts field
    const _bad: SpawnOpts = { garbage: true }
    void _bad
  })
})

describe("Message", () => {
  it("has narrow role union and unknown content", () => {
    expectTypeOf<Message["role"]>().toEqualTypeOf<"user" | "assistant" | "system">()
    expectTypeOf<Message["content"]>().toEqualTypeOf<unknown>()
    expectTypeOf<Message["timestamp"]>().toEqualTypeOf<string>()
    expectTypeOf<Message["sessionId"]>().toEqualTypeOf<string>()
  })
})

describe("AIEngine", () => {
  it("has the five documented methods", () => {
    type Methods = keyof AIEngine
    expectTypeOf<Methods>().toEqualTypeOf<"spawn" | "resume" | "stream" | "readHistory" | "stop">()
  })

  it("spawn returns Promise<SessionHandle>", () => {
    expectTypeOf<AIEngine["spawn"]>().parameters.toEqualTypeOf<[string, string, SpawnOpts?]>()
    expectTypeOf<AIEngine["spawn"]>().returns.toEqualTypeOf<Promise<SessionHandle>>()
  })

  it("resume returns Promise<SessionHandle>", () => {
    expectTypeOf<AIEngine["resume"]>().returns.toEqualTypeOf<Promise<SessionHandle>>()
  })

  it("stream returns AsyncIterable<EngineEvent>", () => {
    expectTypeOf<AIEngine["stream"]>().parameters.toEqualTypeOf<[SessionHandle]>()
    expectTypeOf<AIEngine["stream"]>().returns.toEqualTypeOf<AsyncIterable<EngineEvent>>()
  })

  it("readHistory returns Promise<Message[]>", () => {
    expectTypeOf<AIEngine["readHistory"]>().parameters.toEqualTypeOf<[string]>()
    expectTypeOf<AIEngine["readHistory"]>().returns.toEqualTypeOf<Promise<Message[]>>()
  })

  it("stop returns Promise<void>", () => {
    expectTypeOf<AIEngine["stop"]>().parameters.toEqualTypeOf<[SessionHandle]>()
    expectTypeOf<AIEngine["stop"]>().returns.toEqualTypeOf<Promise<void>>()
  })

  it("a structurally compatible impl is assignable to AIEngine", () => {
    // Smoke check: a minimal in-memory impl satisfies the interface.
    // If this fails to compile, Stream A's port is broken.
    class Impl implements AIEngine {
      async spawn(cwd: string, _prompt: string, _opts?: SpawnOpts): Promise<SessionHandle> {
        return { sessionId: "x", cwd }
      }
      async resume(sessionId: string, _prompt: string, _opts?: SpawnOpts): Promise<SessionHandle> {
        return { sessionId, cwd: "/" }
      }
      stream(_h: SessionHandle): AsyncIterable<EngineEvent> {
        return (async function* () {
          yield { type: "done" } as const
        })()
      }
      async readHistory(_sessionId: string): Promise<Message[]> {
        return []
      }
      async stop(_h: SessionHandle): Promise<void> {}
    }
    expectTypeOf<Impl>().toMatchTypeOf<AIEngine>()
  })
})
