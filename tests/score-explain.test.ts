import { describe, expect, it } from 'vitest'
import { explainScore, mergeAndScore } from '../src/lib/repo-score'
import type { RepoFinding } from '../src/lib/repo-types'

const finding = (file: string, severity: RepoFinding['severity'], category: RepoFinding['category']): RepoFinding => ({
  file,
  severity,
  category,
  title: `${severity} en ${file}`,
  lines: [1],
  explanation: '',
  fix: '',
  origin: 'scan',
})

describe('explainScore · atribución de puntos', () => {
  it('repo limpio: sin deducciones, sin techo, score 100', () => {
    const { categories, score } = mergeAndScore([], [])
    const ex = explainScore(categories, score)
    expect(score).toBe(100)
    expect(ex.deductions).toEqual([])
    expect(ex.rawWeighted).toBe(100)
    expect(ex.cap).toBeNull()
  })

  it('cada hallazgo cuesta severidad × peso de categoría (high security = 15 × 0.3)', () => {
    const { categories, score } = mergeAndScore([finding('a.ts', 'high', 'security')], [])
    const ex = explainScore(categories, score)
    expect(ex.deductions).toHaveLength(1)
    expect(ex.deductions[0]?.category).toBe('security')
    expect(ex.deductions[0]?.count).toBe(1)
    expect(ex.deductions[0]?.cost).toBe(4.5)
    expect(ex.rawWeighted).toBe(score) // sin críticos no hay techo: raw = score
    expect(ex.cap).toBeNull()
  })

  it('agrupa hallazgos iguales: 2 high de security cuestan 9 pts en una sola fila', () => {
    const { categories, score } = mergeAndScore(
      [finding('a.ts', 'high', 'security'), finding('b.ts', 'high', 'security')],
      [],
    )
    const ex = explainScore(categories, score)
    expect(ex.deductions).toHaveLength(1)
    expect(ex.deductions[0]?.count).toBe(2)
    expect(ex.deductions[0]?.cost).toBe(9)
  })

  it('detecta el techo duro: crítico de seguridad limita el score a 35', () => {
    const { categories, score } = mergeAndScore(
      [finding('a.ts', 'critical', 'security'), finding('b.ts', 'low', 'bugs')],
      [],
    )
    expect(score).toBe(35)
    const ex = explainScore(categories, score)
    expect(ex.rawWeighted).toBeGreaterThan(score)
    expect(ex.cap).toEqual({
      score: 35,
      reason: 'Techo duro por hallazgo crítico: el score se limita a 35',
    })
  })

  it('ordena las deducciones por costo descendente', () => {
    const { categories, score } = mergeAndScore(
      [
        finding('a.ts', 'low', 'security'), // 4 × 0.3 = 1.2
        finding('b.ts', 'high', 'bugs'), // 15 × 0.25 = 3.75 → 3.8
        finding('c.ts', 'medium', 'hallucination'), // 8 × 0.3 = 2.4
      ],
      [],
    )
    const ex = explainScore(categories, score)
    expect(ex.deductions.map((d) => d.cost)).toEqual([3.8, 2.4, 1.2])
  })
})
