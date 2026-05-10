/**
 * Provider/use pair factory.
 *
 * Lifted from `refs/opencode/packages/opencode/src/cli/cmd/tui/context/helper.tsx`
 * unchanged. The `init.ready` short-circuit lets context providers gate
 * children on async readiness without each consumer caring.
 */
import { type ParentProps, Show, createContext, useContext } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, unknown>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      return (
        // @ts-expect-error - init may not have `ready`; the Show falls through if undefined.
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
