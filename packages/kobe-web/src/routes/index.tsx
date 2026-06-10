import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "../components/AppShell.tsx"

export const Route = createFileRoute("/")({ component: AppShell })
