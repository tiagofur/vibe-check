// ─────────────────────────────────────────────────────────────
// VibeCheck · Merge de hallazgos + scoring determinista
// Fuente única de verdad usada por la API y el CLI: mismos pesos,
// mismos techos duros ante críticos.
// ─────────────────────────────────────────────────────────────

import type { RepoFinding, RepoReport } from './repo-types'
import { CATEGORY_META, type CategoryKey, scoreFromFindings, verdictFromScore } from './vibe-types'

const CATEGORY_KEYS: CategoryKey[] = ['security', 'hallucination', 'bugs', 'overengineering']
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

export function dedupeFindings(findings: RepoFinding[]): RepoFinding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = `${f.file}|${f.title.toLowerCase().replace(/\s+/g, ' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface MergeOptions {
  /**
   * Modo diff: si se pasa, solo los hallazgos en estos archivos puntúan.
   * El resto (pre-existentes) se excluye del score y de las categorías.
   */
  onlyFiles?: Set<string>
}

export interface MergeResult {
  categories: RepoReport['categories']
  score: number
  allFindings: RepoFinding[]
  /** Hallazgos excluidos por onlyFiles (existentes en código no cambiado) */
  excludedCount: number
}

export function mergeAndScore(
  scanFindings: RepoFinding[],
  aiFindings: RepoFinding[],
  opts?: MergeOptions,
): MergeResult {
  const allFindings = dedupeFindings([...scanFindings, ...aiFindings])
  const scored = opts?.onlyFiles ? allFindings.filter((f) => opts.onlyFiles!.has(f.file)) : allFindings
  const excludedCount = allFindings.length - scored.length

  const categories = {} as RepoReport['categories']
  let globalScore = 0
  for (const key of CATEGORY_KEYS) {
    const merged = scored
      .filter((f) => f.category === key)
      .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
    const score = scoreFromFindings(merged)
    // summary vacío: lo rellena la síntesis de IA si existe
    categories[key] = { score, summary: '', findings: merged }
    globalScore += score * CATEGORY_META[key].weight
  }

  let score = Math.round(globalScore)
  const hasCritical = (k: CategoryKey) => categories[k].findings.some((f) => f.severity === 'critical')
  if (hasCritical('security') || hasCritical('hallucination')) score = Math.min(score, 35)
  else if (hasCritical('bugs') || hasCritical('overengineering')) score = Math.min(score, 55)

  return { categories, score, allFindings, excludedCount }
}

export { verdictFromScore }
