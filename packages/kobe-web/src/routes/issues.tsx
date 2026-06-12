import { createFileRoute } from "@tanstack/react-router"
import { IssuesPage } from "../components/IssuesPage.tsx"

export const Route = createFileRoute("/issues")({ component: IssuesPage })
