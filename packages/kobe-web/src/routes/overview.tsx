import { createFileRoute } from "@tanstack/react-router"
import { Overview } from "../components/Overview.tsx"

export const Route = createFileRoute("/overview")({ component: Overview })
