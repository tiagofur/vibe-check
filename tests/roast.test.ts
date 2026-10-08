import { describe, expect, it } from 'vitest'
import { roastRepo, roastToMarkdown, signalsFromReport, type RoastInput } from '../src/lib/roast'
import type { RepoReport } from '../src/lib/repo-types'

const input = (over: Partial<RoastInput> = {}): RoastInput => ({
  repoName: 'mi-repo',
  verdict: 'SOSPECHOSO',
  signals: {
    secrets: 0,
    envCommitted: 0,
    phantomDeps: 0,
    brokenImports: 0,
    unusedDeps: 0,
    orphans: 0,
    fakeTests: 0,
  },
  diff: null,
  ...over,
})

describe('roastRepo', () => {
  it('es determinista: mismo input → mismas frases', () => {
    const a = roastRepo(input())
    const b = roastRepo(input())
    expect(a).toEqual(b)
  })

  it('siempre abre con una frase del pool del veredicto', () => {
    for (const verdict of ['SHIP IT', 'CASI LISTO', 'SOSPECHOSO', 'PELIGRO'] as const) {
      const first = roastRepo(input({ verdict }))[0]
      expect(first, `verdict ${verdict}`).toBeDefined()
      expect(first.length).toBeGreaterThan(10)
    }
  })

  it('dispara reglas por señal y sustituye los contadores {n}/{s}', () => {
    const lines = roastRepo(
      input({
        signals: {
          secrets: 1,
          envCommitted: 2,
          phantomDeps: 3,
          brokenImports: 1,
          unusedDeps: 4,
          orphans: 17,
          fakeTests: 2,
        },
      }),
    )
    expect(lines.length).toBe(5) // opener + 4 reglas por prioridad (cap)
    for (const line of lines) {
      expect(line).not.toContain('{n}')
      expect(line).not.toContain('{s}')
    }
    // las señales más graves (secretos, fake tests) ganan un hueco
    expect(lines.join(' ')).toMatch(/credencial|regalo/i)
  })

  it('repo limpio: opener + frase de "limpio"', () => {
    const lines = roastRepo(input({ verdict: 'SHIP IT' }))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/limpio|derrota/i)
  })

  it('menciona los hallazgos excluidos en modo diff', () => {
    const lines = roastRepo(input({ diff: { excludedFindings: 12 } }))
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]).toContain('12')
  })

  it('el mismo repo con distintos nombres varía el pick sin romper el formato', () => {
    for (let i = 0; i < 30; i++) {
      const lines = roastRepo(input({ repoName: `repo-${i}` }))
      expect(lines.length).toBeGreaterThanOrEqual(2)
      expect(lines.length).toBeLessThanOrEqual(5)
    }
  })
})

describe('roastToMarkdown', () => {
  it('genera markdown compartible con disclaimer', () => {
    const md = roastToMarkdown('mi-repo', ['frase uno', 'frase dos'])
    expect(md).toContain('## 🔥 Roast de VibeCheck — mi-repo')
    expect(md).toContain('- frase uno')
    expect(md).toContain('humor, no evidencia')
  })
})

describe('signalsFromReport', () => {
  it('mapea los structural checks a señales de roast', () => {
    const report = {
      structural: [
        { id: 'secrets', label: '', status: 'fail', detail: '', count: 2 },
        { id: 'test-integrity', label: '', status: 'fail', detail: '', count: 3 },
        { id: 'orphans', label: '', status: 'warn', detail: '', count: 5 },
      ],
    } as unknown as RepoReport
    const s = signalsFromReport(report)
    expect(s.secrets).toBe(2)
    expect(s.fakeTests).toBe(3)
    expect(s.orphans).toBe(5)
    expect(s.phantomDeps).toBe(0)
  })
})
