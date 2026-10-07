// ─────────────────────────────────────────────────────────────
// VibeCheck · Tendencia histórica de un repo
// Puro y sin I/O: recibe puntos y produce serie + delta.
// Las auditorías en modo diff se excluyen aguas arriba: puntúan
// solo los cambios, no el repo completo.
// ─────────────────────────────────────────────────────────────

export interface TrendPoint {
  score: number
  /** ISO string */
  createdAt: string
}

export type TrendDirection = 'up' | 'down' | 'flat'

export interface Trend {
  /** De más antiguo a más reciente, recortada a los últimos `max` */
  series: TrendPoint[]
  /** Último score menos el anterior; null con menos de 2 puntos */
  delta: number | null
  direction: TrendDirection | null
}

export function computeTrend(points: TrendPoint[], max = 12): Trend {
  if (points.length === 0) {
    return { series: [], delta: null, direction: null }
  }

  const sorted = [...points]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-max)

  const last = sorted[sorted.length - 1]
  const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : undefined
  if (!previous || !last) {
    return { series: sorted, delta: null, direction: null }
  }

  const delta = last.score - previous.score
  const direction: TrendDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  return { series: sorted, delta, direction }
}

/** Flecha unicode para badges y UI */
export function trendArrow(direction: TrendDirection | null): string {
  switch (direction) {
    case 'up':
      return '↗'
    case 'down':
      return '↘'
    case 'flat':
      return '→'
    default:
      return ''
  }
}
