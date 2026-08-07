import { createFileRoute } from "@tanstack/react-router"
import { WorktreesPage } from "../components/WorktreesPage.tsx"

export const Route = createFileRoute("/worktrees")({ component: WorktreesPage })
