// ─────────────────────────────────────────────────────────────
// VibeCheck · Benchmark recall/precisión contra ground truth
// Un repo con defectos plantados + una lista declarada de lo que
// DEBE detectarse → métricas de la herramienta, no confianza a
// ciegas. Puro y sin I/O: el caller carga el JSON y los hallazgos.
// ─────────────────────────────────────────────────────────────

import type { RepoFinding } from './repo-types'

export type BenchKind =
  | 'phantom-import'
  | 'phantom-dep'
  | 'secret'
  | 'fake-test'
  | 'orphan'
  | 'unused-dep'
  | 'env-committed'

export interface BenchEntry {
  /** identificador legible del defecto plantado */
  id: string
  kind: BenchKind
  /** archivo donde vive el defecto (no aplica a deps, que se reportan en package.json) */
  file?: string
  /** nombre del paquete (phantom-dep / unused-dep) */
  name?: string
  /** desambiguador cuando un mismo archivo tiene varios hallazgos del mismo tipo */
  titleIncludes?: string
}

export interface BenchMatch {
  entry: BenchEntry
  finding: RepoFinding
}

export interface BenchResult {
  expected: number
  matched: BenchMatch[]
  missed: BenchEntry[]
  falsePositives: RepoFinding[]
  recall: number
  precision: number
  f1: number
}

/** Clasifica un hallazgo del motor al kind del benchmark; null si no participa */
export function classifyFinding(f: RepoFinding): BenchKind | null {
  if (f.title.startsWith('Import fantasma')) return 'phantom-import'
  if (f.title.includes('Dependencia fantasma')) return 'phantom-dep'
  if (f.title.includes('entorno commiteado')) return 'env-committed'
  if (f.title.includes('huérfano')) return 'orphan'
  if (f.title.includes('sin uso')) return 'unused-dep'
  if (f.category === 'security') return 'secret'
  // los hallazgos de tests falsos viven en archivos de test con categoría bugs
  if (f.category === 'bugs' && /(^|\/)(tests?|specs?|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.py$|(^|\/)test_[^/]*\./i.test(f.file)) {
    return 'fake-test'
  }
  return null
}

function entryMatches(f: RepoFinding, e: BenchEntry): boolean {
  if (classifyFinding(f) !== e.kind) return false
  if (e.file && f.file !== e.file && !f.explanation.includes(e.file)) return false
  if (e.name && !f.title.includes(e.name) && !f.explanation.includes(e.name)) return false
  if (e.titleIncludes && !f.title.includes(e.titleIncludes)) return false
  return true
}

/** Empareja hallazgos con expectativas: TP, FN (faltantes) y FP (no esperados) */
export function matchBench(entries: BenchEntry[], findings: RepoFinding[]): BenchResult {
  const used = new Set<RepoFinding>()
  const matched: BenchMatch[] = []
  const missed: BenchEntry[] = []
  for (const entry of entries) {
    const finding = findings.find((f) => !used.has(f) && entryMatches(f, entry))
    if (finding) {
      used.add(finding)
      matched.push({ entry, finding })
    } else {
      missed.push(entry)
    }
  }
  const falsePositives = findings.filter((f) => !used.has(f))
  const tp = matched.length
  const recall = entries.length === 0 ? 1 : tp / entries.length
  const precision = tp + falsePositives.length === 0 ? 1 : tp / (tp + falsePositives.length)
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision)
  return {
    expected: entries.length,
    matched,
    missed,
    falsePositives,
    recall,
    precision,
    f1,
  }
}
