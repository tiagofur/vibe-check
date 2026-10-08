// ─────────────────────────────────────────────────────────────
// VibeCheck · Merge de hallazgos + scoring determinista
// Fuente única de verdad usada por la API y el CLI: mismos pesos,
// mismos techos duros ante críticos.
// ─────────────────────────────────────────────────────────────

import type { RepoFinding, RepoReport, ScoreDeduction, ScoreExplanation } from './repo-types'
import { CATEGORY_META, SEVERITY_META, type CategoryKey, scoreFromFindings, verdictFromScore } from './vibe-types'
import { isEnvExamplePath } from './repo-scan'

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

/**
 * Un hallazgo IA que repite uno del escaneo determinista (mismo archivo,
 * categoría y ±2 líneas) no suma dos veces: el scan es la fuente autoritativa
 * (verificable) y el duplicado de IA se descarta.
 */
export function dropAiDuplicates(scanFindings: RepoFinding[], aiFindings: RepoFinding[]): RepoFinding[] {
  return aiFindings.filter((a) => {
    const duplicated = scanFindings.some(
      (s) =>
        s.file === a.file &&
        s.category === a.category &&
        (s.lines.length === 0 || a.lines.length === 0
          ? true
          : s.lines.some((sl) => a.lines.some((al) => Math.abs(al - sl) <= 2))),
    )
    return !duplicated
  })
}

/**
 * Los .env.example/.sample/.template existen PARA commitearse con valores de
 * ejemplo: el escáner determinista no los trata como filtraciones, así que un
 * hallazgo IA de seguridad sobre ellos tampoco puede clavar el score. Se
 * degrada a low (si el valor fuera real, igual deja la señal).
 */
export function downgradeAiEnvExampleSecrets(aiFindings: RepoFinding[]): RepoFinding[] {
  return aiFindings.map((f) =>
    f.origin === 'ai' && f.category === 'security' && f.severity !== 'low' && isEnvExamplePath(f.file)
      ? {
          ...f,
          severity: 'low',
          explanation: `${f.explanation} El archivo es un .env.example: está hecho para commitearse con valores de ejemplo.`,
        }
      : f,
  )
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
  const aiFindingsFiltered = downgradeAiEnvExampleSecrets(aiFindings)
  const allFindings = dedupeFindings([...scanFindings, ...dropAiDuplicates(scanFindings, aiFindingsFiltered)])
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

/**
 * Atribución de puntos: dado el reporte por categorías y el score final,
 * deduce cuánto costó cada grupo de hallazgos y si se aplicó un techo duro.
 * Todo es derivable de `categories` + `score`, así que funciona también con
 * reportes antiguos que no traigan `scoreExplanation`.
 */
export function explainScore(
  categories: RepoReport['categories'],
  score: number,
): ScoreExplanation {
  const groups = new Map<string, ScoreDeduction>()
  let rawWeighted = 0
  for (const key of CATEGORY_KEYS) {
    const cat = categories[key]
    if (!cat) continue
    rawWeighted += cat.score * CATEGORY_META[key].weight
    for (const f of cat.findings) {
      const gkey = `${key}:${f.severity}`
      const group = groups.get(gkey) ?? {
        key: gkey,
        category: key,
        severity: f.severity,
        count: 0,
        cost: 0,
      }
      group.count += 1
      group.cost += SEVERITY_META[f.severity]?.weight ?? 4
      groups.set(gkey, group)
    }
  }
  const deductions = [...groups.values()]
    .map((g) => ({
      ...g,
      cost: Math.round(g.cost * CATEGORY_META[g.category].weight * 10) / 10,
    }))
    .sort((a, b) => b.cost - a.cost || b.count - a.count)

  const raw = Math.round(rawWeighted)
  const cap =
    raw > score
      ? { score, reason: `Techo duro por hallazgo crítico: el score se limita a ${score}` }
      : null
  return { score, rawWeighted: raw, cap, deductions }
}
