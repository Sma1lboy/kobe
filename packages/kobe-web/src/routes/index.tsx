import { createFileRoute } from "@tanstack/react-router"
import { ChatShell } from "../components/ChatShell.tsx"

// The home surface is the /chat GUI terminal shell — it supersedes the old
// AppShell workspace. AppShell stays reachable only via /task/$taskId deep
// links; Board / Worktrees route back here.
export const Route = createFileRoute("/")({ component: ChatShell })
