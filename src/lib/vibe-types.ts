// ─────────────────────────────────────────────────────────────
// VibeCheck · Tipos y scoring compartidos entre frontend y backend
// Licencia: MIT · Hecho con 💚 para la comunidad dev
// ─────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Finding {
  severity: Severity
  title: string
  lines: number[]
  explanation: string
  fix: string
}

export interface CategoryReport {
  score: number
  summary: string
  findings: Finding[]
}

export type CategoryKey = 'security' | 'hallucination' | 'bugs' | 'overengineering'

export interface VibeReport {
  score: number
  verdict: Verdict
  summary: string
  categories: Record<CategoryKey, CategoryReport>
}

export type Verdict = 'SHIP IT' | 'CASI LISTO' | 'SOSPECHOSO' | 'PELIGRO'

export const CATEGORY_META: Record<
  CategoryKey,
  { label: string; icon: string; description: string; weight: number }
> = {
  security: {
    label: 'Seguridad',
    icon: '🔒',
    description: 'Secretos, inyecciones, validación y auth',
    weight: 0.3,
  },
  hallucination: {
    label: 'Alucinaciones',
    icon: '👻',
    description: 'APIs y paquetes que la IA inventó',
    weight: 0.3,
  },
  bugs: {
    label: 'Bugs',
    icon: '🐛',
    description: 'Errores lógicos y edge cases',
    weight: 0.25,
  },
  overengineering: {
    label: 'Sobre-ingeniería',
    icon: '🏭',
    description: 'Complejidad que nadie pidió',
    weight: 0.15,
  },
}

export const SEVERITY_META: Record<
  Severity,
  { label: string; weight: number; classes: string; dot: string }
> = {
  critical: {
    label: 'Crítico',
    weight: 25,
    classes: 'bg-red-500/15 text-red-400 border-red-500/30',
    dot: 'bg-red-500',
  },
  high: {
    label: 'Alto',
    weight: 15,
    classes: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    dot: 'bg-orange-500',
  },
  medium: {
    label: 'Medio',
    weight: 8,
    classes: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    dot: 'bg-amber-500',
  },
  low: {
    label: 'Bajo',
    weight: 4,
    classes: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    dot: 'bg-violet-500',
  },
  info: {
    label: 'Info',
    weight: 1,
    classes: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
    dot: 'bg-zinc-500',
  },
}

export const VERDICT_META: Record<
  Verdict,
  { emoji: string; classes: string; message: string }
> = {
  'SHIP IT': {
    emoji: '🚀',
    classes: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    message: 'Código limpio. Puedes subirlo con confianza.',
  },
  'CASI LISTO': {
    emoji: '🟡',
    classes: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    message: 'Nada grave, pero revisa los hallazgos antes de subir.',
  },
  SOSPECHOSO: {
    emoji: '🤨',
    classes: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    message: 'Hay cosas raras aquí. La IA quizá te mintió.',
  },
  PELIGRO: {
    emoji: '🚨',
    classes: 'bg-red-500/15 text-red-400 border-red-500/30',
    message: 'NO subas esto a producción. Hay problemas serios.',
  },
}

/** Penalización determinista por severidad → score 0-100 por categoría */
export function scoreFromFindings(findings: Finding[]): number {
  let penalty = 0
  for (const f of findings) {
    penalty += SEVERITY_META[f.severity]?.weight ?? 4
  }
  return Math.max(0, 100 - penalty)
}

export function verdictFromScore(score: number): Verdict {
  if (score >= 80) return 'SHIP IT'
  if (score >= 60) return 'CASI LISTO'
  if (score >= 40) return 'SOSPECHOSO'
  return 'PELIGRO'
}

export function scoreColor(score: number): string {
  if (score >= 80) return '#10b981' // emerald
  if (score >= 60) return '#f59e0b' // amber
  if (score >= 40) return '#f97316' // orange
  return '#ef4444' // red
}

export function scoreLabel(score: number): string {
  if (score >= 80) return 'Vibes immaculados'
  if (score >= 60) return 'Vibes decentes'
  if (score >= 40) return 'Vibes cuestionables'
  return 'Vibes tóxicos'
}

export interface CheckHistoryItem {
  id: string
  title: string
  language: string
  score: number
  verdict: Verdict
  createdAt: string
}

export interface AnalyzeResponse {
  id: string
  report: VibeReport
}

export const LANGUAGES = [
  { value: 'auto', label: 'Detección automática' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'csharp', label: 'C#' },
  { value: 'sql', label: 'SQL' },
  { value: 'other', label: 'Otro' },
] as const

export const MAX_CODE_LENGTH = 12000
