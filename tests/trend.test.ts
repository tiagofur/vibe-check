import { describe, expect, it } from 'vitest'
import { computeTrend, trendArrow } from '../src/lib/trend'

const p = (score: number, createdAt: string) => ({ score, createdAt })

describe('computeTrend', () => {
  it('ordena la serie de antiguo a nuevo aunque llegue desordenada', () => {
    const t = computeTrend([p(80, '2026-01-03'), p(60, '2026-01-01'), p(70, '2026-01-02')])
    expect(t.series.map((x) => x.score)).toEqual([60, 70, 80])
  })

  it('delta y dirección suben/bajan/planas', () => {
    expect(computeTrend([p(70, 'a'), p(82, 'b')]).delta).toBe(12)
    expect(computeTrend([p(70, 'a'), p(82, 'b')]).direction).toBe('up')
    expect(computeTrend([p(90, 'a'), p(78, 'b')]).direction).toBe('down')
    expect(computeTrend([p(90, 'a'), p(90, 'b')]).direction).toBe('flat')
  })

  it('con un solo punto no hay delta', () => {
    const t = computeTrend([p(95, 'a')])
    expect(t.delta).toBeNull()
    expect(t.direction).toBeNull()
    expect(t.series).toHaveLength(1)
  })

  it('recorta a los últimos max puntos', () => {
    const many = Array.from({ length: 20 }, (_, i) => p(50 + i, `2026-01-${String(i + 1).padStart(2, '0')}`))
    const t = computeTrend(many, 12)
    expect(t.series).toHaveLength(12)
    expect(t.series[0]?.score).toBe(58)
    expect(t.delta).toBe(1)
  })

  it('sin puntos devuelve estructura vacía', () => {
    expect(computeTrend([])).toEqual({ series: [], delta: null, direction: null })
  })
})

describe('trendArrow', () => {
  it('flechas por dirección', () => {
    expect(trendArrow('up')).toBe('↗')
    expect(trendArrow('down')).toBe('↘')
    expect(trendArrow('flat')).toBe('→')
    expect(trendArrow(null)).toBe('')
  })
})
