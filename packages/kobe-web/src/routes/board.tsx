import { createFileRoute } from "@tanstack/react-router"
import { Board } from "../components/Board.tsx"

export const Route = createFileRoute("/board")({ component: Board })
