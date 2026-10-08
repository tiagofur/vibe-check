// ─────────────────────────────────────────────────────────────
// VibeCheck · Tipos del modo repositorio
// ─────────────────────────────────────────────────────────────

import type { CategoryKey, Finding, Severity, Verdict } from './vibe-types'

export interface RepoFile {
  path: string
  content: string
}

/** Hallazgo con referencia al archivo del repo y su categoría */
export interface RepoFinding extends Finding {
  file: string
  origin: 'scan' | 'ai'
  category: CategoryKey
}

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface StructuralCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
  count: number
}

/** Cuántos puntos del score final cuesta un grupo de hallazgos (categoría × severidad) */
export interface ScoreDeduction {
  key: string
  category: CategoryKey
  severity: Severity
  count: number
  /** puntos descontados: peso de severidad × peso de categoría (1 decimal) */
  cost: number
}

/** Desglose "¿por qué N/100?": atribución de puntos + techos duros aplicados */
export interface ScoreExplanation {
  score: number
  /** score antes de aplicar techos duros por hallazgos críticos */
  rawWeighted: number
  cap: { score: number; reason: string } | null
  deductions: ScoreDeduction[]
}

export interface RepoReport {
  score: number
  verdict: Verdict
  repoName: string
  source: 'github' | 'files'
  branch: string | null
  stars: number | null
  summary: string
  architecture: string
  stats: {
    filesScanned: number
    filesAudited: number
    totalLines: number
    languages: string[]
    truncated: boolean
  }
  /** Presente cuando se auditó en modo diff (solo los cambios vs un ref base) */
  diff?: {
    base: string
    filesAdded: number
    filesModified: number
    filesDeleted: number
    /** Hallazgos pre-existentes excluidos del score por tocar código no cambiado */
    excludedFindings: number
  }
  vibeSignals: { title: string; detail: string }[]
  topRisks: { title: string; detail: string; severity: Severity }[]
  structural: StructuralCheck[]
  categories: Record<CategoryKey, { score: number; summary: string; findings: RepoFinding[] }>
  /** Presente en reportes nuevos: por qué el score es N (reportes cacheados viejos pueden omitirlo) */
  scoreExplanation?: ScoreExplanation
}

export interface RepoCheckHistoryItem {
  id: string
  repoName: string
  source: string
  branch: string | null
  score: number
  verdict: Verdict
  filesAudited: number
  createdAt: string
}

export interface AnalyzeRepoResponse {
  id: string
  report: RepoReport
}
