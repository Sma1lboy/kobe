/** @jsxImportSource @opentui/react */

import type { VendorId } from "@/types/vendor"
import type { AdoptableWorktree } from "@/types/worktree"
import type { NewTaskInput } from "../../../tui/component/new-task-dialog/state"
import type { DialogContext } from "../../ui/dialog"
import { NewTaskDialogView } from "./dialog"

export type { NewTaskInput } from "../../../tui/component/new-task-dialog/state"
export { isBlankText, stripNewlines } from "../../../tui/component/new-task-dialog/state"

export type NewTaskDialogOptions = {
  defaultCloneParent?: string
  defaultVendor?: VendorId
  availableVendors?: readonly VendorId[]
  discoverAdoptable?: (repo: string) => Promise<readonly AdoptableWorktree[]>
}

function show(
  dialog: DialogContext,
  defaultRepo: string,
  savedRepos: readonly string[],
  options?: NewTaskDialogOptions,
): Promise<NewTaskInput | undefined> {
  return new Promise<NewTaskInput | undefined>((resolve) => {
    dialog.replace(
      () => (
        <NewTaskDialogView
          defaultRepo={defaultRepo}
          savedRepos={savedRepos}
          defaultCloneParent={options?.defaultCloneParent}
          defaultVendor={options?.defaultVendor}
          availableVendors={options?.availableVendors}
          discoverAdoptable={options?.discoverAdoptable}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
    dialog.setSize("medium")
  })
}

export const NewTaskDialog = {
  show,
}
