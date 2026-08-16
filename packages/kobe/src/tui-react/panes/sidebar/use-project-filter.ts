/**
 * Repo context filter (issue #29): a pure VIEW-layer filter over the tree
 * sidebar — nothing is persisted, no session/grouping entity exists.
 * `ctrl+p` cycles all → project A → project B → … → all over the projects
 * the current view actually contains.
 */

import type { Task } from "@/types/task"
import { useCallback, useEffect, useMemo, useState } from "react"
import { sidebarProjectKey } from "../../../tui/panes/sidebar/groups"
import { projectKeysOf } from "../../../tui/panes/sidebar/tree-core"
import { cycleProjectFilterTarget } from "../../../tui/panes/sidebar/view-core"

export interface ProjectFilterState {
  /** Active project key, or null = all projects. */
  readonly filter: string | null
  /** `viewTasks` scoped to the filter (identity-stable when no filter). */
  readonly tasks: readonly Task[]
  /** The `ctrl+p` handler. */
  readonly cycle: () => void
}

export function useProjectFilter(viewTasks: readonly Task[]): ProjectFilterState {
  const [filter, setFilter] = useState<string | null>(null)

  const tasks = useMemo(() => {
    if (filter === null) return viewTasks
    return viewTasks.filter((task) => sidebarProjectKey(task.repo) === filter)
  }, [viewTasks, filter])

  // A filter whose project vanished (last task deleted / view switched)
  // would show a permanently empty list — clear it instead.
  useEffect(() => {
    if (filter === null) return
    if (!projectKeysOf(viewTasks).includes(filter)) setFilter(null)
  }, [viewTasks, filter])

  const cycle = useCallback((): void => {
    setFilter(cycleProjectFilterTarget(projectKeysOf(viewTasks), filter))
  }, [viewTasks, filter])

  return { filter, tasks, cycle }
}
