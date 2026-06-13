/**
 * Compat re-export. The shared PR chip converged onto components/chips.tsx
 * (which the rail, the board, and the Overview all import) when the kanban
 * board landed; this module stays as a stable import path. The precedence
 * rules live in lib/pr-chip.ts (pure, unit-tested).
 */

export { PrChip } from "./chips.tsx"
