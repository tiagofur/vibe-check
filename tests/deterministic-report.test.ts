import { describe, expect, it } from 'vitest'
import { buildDeterministicNarrative } from '../src/lib/deterministic-report'
import { mergeAndScore } from '../src/lib/repo-score'
import type { RepoFinding } from '../src/lib/repo-types'
import type { StructuralCheck } from '../src/lib/repo-types'

const finding = (file: string, severity: RepoFinding['severity'], category: RepoFinding['category'], title: string): RepoFinding => ({
  file,
  severity,
  category,
  title,
  lines: [1],
  explanation: `Explicación de ${title}`,
  fix: 'fix',
  origin: 'scan',
})

const structural: StructuralCheck[] = [
  { id: 'secrets', label: 'Secretos', status: 'fail', detail: '2', count: 2 },
  { id: 'test-integrity', label: 'Integridad de tests', status: 'fail', detail: '1', count: 1 },
  { id: 'manifest', label: 'Manifiesto', status: 'pass', detail: 'ok', count: 1 },
]

describe('buildDeterministicNarrative', () => {
  it('redacta summary/riesgos/señales solo con hechos del escaneo', () => {
    const { categories, score } = mergeAndScore(
      [
        finding('src/server.ts', 'critical', 'security', 'AWS Access Key'),
        finding('src/auth.ts', 'high', 'hallucination', 'Import fantasma'),
        finding('src/login.test.ts', 'high', 'bugs', 'Suite de tests que no puede fallar'),
        finding('docs/x.md', 'low', 'overengineering', '1 archivo(s) huérfano(s)'),
      ],
      [],
    )
    const narrative = buildDeterministicNarrative({
      repoName: 'mi-repo',
      branch: 'main',
      verdict: 'PELIGRO',
      stats: { filesScanned: 120, filesAudited: 0, totalLines: 5000, languages: ['TypeScript'] },
      structural,
      categories,
      manifestName: 'package.json',
    })

    expect(narrative.summary).toContain('sin IA')
    expect(narrative.summary).toContain('120 archivos')
    expect(narrative.summary).toContain('1 crítico')
    expect(narrative.summary).toContain('2 de severidad alta')
    expect(narrative.architecture).toContain('package.json')
    // solo críticos/altos, máximo 4
    expect(narrative.topRisks).toHaveLength(3)
    expect(narrative.topRisks.every((r) => ['critical', 'high'].includes(r.severity))).toBe(true)
    // señales derivadas de los structural checks con count > 0
    const titles = narrative.vibeSignals.map((s) => s.title)
    expect(titles).toContain('Secretos en el código')
    expect(titles).toContain('Tests que no pueden fallar')
    expect(titles).not.toContain('.env commiteado')
    // summaries por categoría, todos presentes
    expect(Object.keys(narrative.categorySummaries)).toHaveLength(4)
    expect(narrative.categorySummaries.security).toContain('1 hallazgo')
    expect(narrative.categorySummaries.overengineering).toContain('1 hallazgo')
  })

  it('repo limpio: cero hallazgos redactado como verificación positiva', () => {
    const { categories } = mergeAndScore([], [])
    const narrative = buildDeterministicNarrative({
      repoName: 'limpio',
      branch: null,
      verdict: 'SHIP IT',
      stats: { filesScanned: 10, filesAudited: 0, totalLines: 400, languages: [] },
      structural,
      categories,
      manifestName: null,
    })
    expect(narrative.summary).toContain('0 hallazgos')
    expect(narrative.categorySummaries.security).toContain('Sin hallazgos')
    expect(narrative.topRisks).toHaveLength(0)
    expect(narrative.architecture).toContain('sin manifiesto')
  })
})
