// ─────────────────────────────────────────────────────────────
// VibeCheck · Cliente del stream NDJSON de progreso (side safe:
// usable desde componentes cliente sin importar código de server)
// ─────────────────────────────────────────────────────────────

import type { RepoReport } from './repo-types'

export type RepoStreamEvent =
  | { type: 'progress'; phase: string; pct: number; message: string }
  | { type: 'done'; id: string; report: RepoReport; cached: boolean }
  | { type: 'error'; error: string }

/** Parsea una línea del stream; devuelve null si no es un evento válido */
export function parseRepoStreamLine(line: string): RepoStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<RepoStreamEvent>
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed.type === 'progress' || parsed.type === 'done' || parsed.type === 'error')
    ) {
      return parsed as RepoStreamEvent
    }
    return null
  } catch {
    return null
  }
}
