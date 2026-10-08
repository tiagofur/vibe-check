import { describe, expect, it } from 'vitest'
import { buildFindingPrompt, buildFixPack, sortedFindings } from '../src/lib/fix-prompts'
import { mergeAndScore, verdictFromScore } from '../src/lib/repo-score'
import type { RepoFinding, RepoReport } from '../src/lib/repo-types'

const finding = (
  file: string,
  severity: RepoFinding['severity'],
  category: RepoFinding['category'],
  title: string,
  origin: RepoFinding['origin'] = 'scan',
): RepoFinding => ({
  file,
  severity,
  category,
  title,
  lines: [3, 7],
  explanation: `Explicación de ${title}`,
  fix: `Arregla ${title} así`,
  origin,
})

const report = (findings: RepoFinding[], over: Partial<RepoReport> = {}): RepoReport => {
  const merged = mergeAndScore(findings, [])
  return {
    score: merged.score,
    verdict: verdictFromScore(merged.score),
    repoName: 'mi-repo',
    engine: 'determinista',
    categories: merged.categories,
    ...over,
  } as unknown as RepoReport
}

describe('sortedFindings', () => {
  it('ordena por severidad y prefiere verificados (scan) a igualdad', () => {
    const findings = [
      finding('a.ts', 'low', 'bugs', 'bajo'),
      finding('c.ts', 'high', 'security', 'alto-ai', 'ai'),
      finding('b.ts', 'high', 'security', 'alto-scan', 'scan'),
      finding('d.ts', 'critical', 'security', 'critico'),
    ]
    const sorted = sortedFindings(report(findings))
    expect(sorted[0]!.title).toBe('critico')
    expect(sorted.slice(1, 3).map((f) => f.title)).toEqual(['alto-scan', 'alto-ai'])
    expect(sorted[3]!.title).toBe('bajo')
  })
})

describe('buildFindingPrompt', () => {
  it('es autocontenido: archivo, líneas, severidad, problema y corrección', () => {
    const prompt = buildFindingPrompt(finding('src/auth/login.ts', 'critical', 'security', 'Stripe live key'))
    expect(prompt).toContain('`src/auth/login.ts` (líneas 3, 7)')
    expect(prompt).toContain('[CRÍTICO · Seguridad] Stripe live key')
    expect(prompt).toContain('Problema: Explicación de Stripe live key')
    expect(prompt).toContain('Corrección sugerida: Arregla Stripe live key así')
    expect(prompt).toContain('Limita el cambio a este hallazgo')
  })
})

describe('buildFixPack', () => {
  it('checklist sincronizada con las secciones de prompts, en orden', () => {
    const base = report([
      finding('a.ts', 'low', 'bugs', 'bajo'),
      finding('b.ts', 'critical', 'security', 'critico'),
    ])
    const pack = buildFixPack(base)
    expect(pack).toContain('# 🛠 Fix pack — mi-repo')
    expect(pack).toContain(`**Vibe Score:** ${base.score}/100 · **Veredicto:** ${base.verdict}`)
    expect(pack).toContain('- [ ] 1. **[CRÍTICO]**')
    expect(pack).toContain('- [ ] 2. **[BAJO]**')
    // cada prompt va en un bloque de código listo para copiar
    expect((pack.match(/```text/g) ?? []).length).toBe(2)
    const section1 = pack.indexOf('## 1.')
    const section2 = pack.indexOf('## 2.')
    expect(pack.slice(section1, section2)).toContain('critico')
  })

  it('incluye el desglose del score cuando viene en el reporte', () => {
    const base = report([finding('a.ts', 'critical', 'security', 'critico')])
    const pack = buildFixPack({ ...base, scoreExplanation: { score: 35, rawWeighted: 90, cap: { score: 35, reason: 'Techo duro' }, deductions: [] } })
    expect(pack).toContain('## ¿Por qué este score?')
    expect(pack).toContain('⬆️ Techo duro')
  })

  it('repo limpio: pack feliz sin checklist', () => {
    const pack = buildFixPack(report([]))
    expect(pack).toContain('🎉 Nada que corregir')
    expect(pack).not.toContain('- [ ]')
  })

  it('marca los hallazgos verificados en la checklist', () => {
    const pack = buildFixPack(report([finding('a.ts', 'high', 'bugs', 'alto', 'scan'), finding('b.ts', 'high', 'bugs', 'alto-ia', 'ai')]))
    expect(pack).toMatch(/1\. \*\*\[ALTO\]\*\* alto — `a\.ts` \(L3, L7\) · ✓verificado/)
    expect(pack).not.toMatch(/alto-ia.*✓verificado/)
  })
})
