import { createFileRoute } from "@tanstack/react-router"
import { ChatShell } from "../components/ChatShell.tsx"

export const Route = createFileRoute("/chat")({ component: ChatShell })
