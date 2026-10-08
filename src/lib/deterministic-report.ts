// ─────────────────────────────────────────────────────────────
// VibeCheck · Narrativa determinista para reportes sin IA
// Cuando no hay credenciales de IA (o el LLM falla), el reporte
// se redacta con hechos del escaneo: reproducible, cero LLM.
// ─────────────────────────────────────────────────────────────

import type { RepoFinding, RepoReport, StructuralCheck } from './repo-types'
import { CATEGORY_META, VERDICT_META, type CategoryKey, type Verdict } from './vibe-types'

export interface DeterministicInput {
  repoName: string
  branch: string | null
  verdict: Verdict
  stats: { filesScanned: number; filesAudited: number; totalLines: number; languages: string[] }
  structural: StructuralCheck[]
  categories: RepoReport['categories']
  manifestName: string | null
}

export interface DeterministicNarrative {
  summary: string
  architecture: string
  vibeSignals: { title: string; detail: string }[]
  topRisks: { title: string; detail: string; severity: RepoFinding['severity'] }[]
  categorySummaries: Record<CategoryKey, string>
}

function countBySeverity(findings: RepoFinding[]): { critical: number; high: number } {
  let critical = 0
  let high = 0
  for (const f of findings) {
    if (f.severity === 'critical') critical++
    else if (f.severity === 'high') high++
  }
  return { critical, high }
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

/**
 * Redacta summary/arquitectura/señales/riesgos/summaries por categoría
 * usando SOLO hechos verificables del escaneo determinista.
 */
export function buildDeterministicNarrative(input: DeterministicInput): DeterministicNarrative {
  const findings = Object.values(input.categories).flatMap((c) => c.findings)
  const { critical, high } = countBySeverity(findings)
  const manifestLabel = input.manifestName ?? 'sin manifiesto de dependencias'

  const summary =
    `Auditoría determinista sin IA: ${input.stats.filesScanned} archivos escaneados, ` +
    `${findings.length} hallazgo${findings.length === 1 ? '' : 's'} (${critical} crítico${critical === 1 ? '' : 's'}, ${high} de severidad alta). ` +
    `${VERDICT_META[input.verdict].message}`

  const architecture =
    `Grafo de imports de ${input.stats.filesAudited} archivos leídos contra ${manifestLabel}. ` +
    `Lenguajes: ${input.stats.languages.slice(0, 4).join(', ') || 'n/d'}. Motor 100% reproducible, cero LLM — ` +
    `cada hallazgo marcado "verificado" sale del escaneo determinista, no de una opinión de modelo.`

  const signals: { title: string; detail: string }[] = []
  const byId = new Map(input.structural.map((c) => [c.id, c]))
  const addSignal = (id: string, title: string, detail: string) => {
    const check = byId.get(id)
    if (check && check.count > 0) signals.push({ title, detail })
  }
  addSignal('secrets', 'Secretos en el código', 'Patrones de credenciales detectados en el árbol. Revócalas y muévelas a variables de entorno.')
  addSignal('env-committed', '.env commiteado', 'Hay archivos de entorno dentro del repo: la causa #1 de filtraciones accidentales.')
  addSignal('test-integrity', 'Tests que no pueden fallar', 'Suites sin asserts, assertions tautológicas, cuerpos vacíos o tests saltados.')
  addSignal('phantom-deps', 'Dependencias fantasma', 'Paquetes importados que no están declarados: un npm ci limpio rompe el build.')
  addSignal('broken-imports', 'Imports rotos', 'Imports a módulos locales que no existen: la IA escribió llamadas a archivos que nunca creó.')
  addSignal('orphans', 'Archivos que nadie importa', 'Módulos sin inbound edges y sin rol de entry point: código "por si acaso".')

  const topRisks = [...findings]
    .sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0))
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 4)
    .map((f) => ({
      title: f.title,
      detail: `${f.file} — ${f.explanation}`,
      severity: f.severity,
    }))

  const categorySummaries = {} as Record<CategoryKey, string>
  for (const key of Object.keys(input.categories) as CategoryKey[]) {
    const n = input.categories[key].findings.length
    categorySummaries[key] =
      n === 0
        ? 'Sin hallazgos — verificado determinísticamente.'
        : `${n} hallazgo${n === 1 ? '' : 's'} de ${CATEGORY_META[key].label.toLowerCase()} verificados por el motor determinista.`
  }

  return { summary, architecture, vibeSignals: signals, topRisks, categorySummaries }
}
