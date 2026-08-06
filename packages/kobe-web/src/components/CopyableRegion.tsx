/**
 * CopyableRegion — hover wrapper that floats a CopyButton over any transcript
 * region (assistant runs, code, tool output). Layout-neutral: children render
 * untouched; the button appears top-right on hover only.
 */

import type { ReactNode } from "react"
import { CopyButton } from "./CopyButton.tsx"

export function CopyableRegion({
  text,
  children,
}: {
  text: string | (() => string)
  children: ReactNode
}) {
  return (
    // Reserved in-flow action row BELOW the response (the Claude.ai shape):
    // no overlap with neighbours, no layout shift on hover.
    <div className="group/copy w-fit max-w-full">
      {children}
      <div className="flex h-5 items-center">
        <CopyButton
          text={text}
          className="opacity-0 focus-visible:opacity-100 group-hover/copy:opacity-100"
        />
      </div>
    </div>
  )
}
