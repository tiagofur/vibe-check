// ─────────────────────────────────────────────────────────────
// VibeCheck · Fix pack: exportar hallazgos como prompts
// Convierte cada hallazgo en un prompt autocontenido para pegar
// en un agente IA (Cursor, Claude Code, Copilot) y corregir
// parte por parte. Puro: mismo input → mismo pack.
// ─────────────────────────────────────────────────────────────

import type { RepoFinding, RepoReport } from './repo-types'
import { explainScore } from './repo-score'
import { CATEGORY_META, SEVERITY_META, type CategoryKey } from './vibe-types'

/** Campos que el pack necesita: el CLI puede construirlos sin síntesis de IA */
export type FixPackInput = Pick<
  RepoReport,
  'repoName' | 'score' | 'verdict' | 'categories' | 'scoreExplanation' | 'engine'
>

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

/** Hallazgos del reporte ordenados: severidad desc, verificados (scan) primero */
export function sortedFindings(report: FixPackInput): RepoFinding[] {
  return (Object.keys(report.categories) as CategoryKey[])
    .flatMap((key) => report.categories[key].findings)
    .sort(
      (a, b) =>
        (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) ||
        (a.origin === b.origin ? 0 : a.origin === 'scan' ? -1 : 1) ||
        a.file.localeCompare(b.file),
    )
}

/** Prompt autocontenido para UN hallazgo: listo para pegar en un agente IA */
export function buildFindingPrompt(finding: RepoFinding): string {
  const severity = (SEVERITY_META[finding.severity]?.label ?? finding.severity).toUpperCase()
  const category = CATEGORY_META[finding.category]?.label ?? finding.category
  const linesLabel = finding.lines.length ? ` (líneas ${finding.lines.slice(0, 5).join(', ')})` : ''

  const parts: string[] = [
    `Arregla este hallazgo de auditoría VibeCheck en \`${finding.file}\`${linesLabel}.`,
    '',
    `[${severity} · ${category}] ${finding.title}`,
    `Problema: ${finding.explanation}`,
    `Corrección sugerida: ${finding.fix}`,
  ]
  if (finding.lines.length) {
    parts.push('', `Líneas afectadas: ${finding.lines.slice(0, 10).join(', ')}.`)
  }
  parts.push(
    '',
    'Limita el cambio a este hallazgo: no refactorices de más ni toques código ajeno.',
    'Al terminar, verifica que los tests pasan y que el hallazgo desaparece re-auditando con VibeCheck.',
  )
  return parts.join('\n')
}

/** Documento markdown completo: encabezado + checklist + un prompt por hallazgo */
export function buildFixPack(report: FixPackInput): string {
  const findings = sortedFindings(report)
  const date = new Date().toISOString().slice(0, 10)
  const engine =
    report.engine === 'determinista' ? 'motor determinista (sin IA)' : 'motor determinista + auditoría IA'

  const lines: string[] = [
    `# 🛠 Fix pack — ${report.repoName}`,
    '',
    `**Vibe Score:** ${report.score}/100 · **Veredicto:** ${report.verdict} · **Motor:** ${engine} · **Fecha:** ${date}`,
    '',
  ]

  const explanation = report.scoreExplanation ?? explainScore(report.categories, report.score)
  if (explanation.deductions.length > 0 || explanation.cap) {
    lines.push('## ¿Por qué este score?', '')
    for (const d of explanation.deductions) {
      lines.push(
        `- **−${d.cost} pts** · ${d.count} hallazgo${d.count !== 1 ? 's' : ''} de ${CATEGORY_META[d.category].label.toLowerCase()} (${SEVERITY_META[d.severity].label.toLowerCase()})`,
      )
    }
    if (explanation.cap) lines.push(`- ⬆️ ${explanation.cap.reason}`)
    lines.push('')
  }

  if (findings.length === 0) {
    lines.push('🎉 Nada que corregir: no se encontró ningún hallazgo.', '', '---', '_Generado con VibeCheck · Open Source (MIT)_')
    return lines.join('\n')
  }

  lines.push(`## Checklist de corrección (${findings.length} hallazgos)`, '')
  findings.forEach((f, i) => {
    const severity = (SEVERITY_META[f.severity]?.label ?? f.severity).toUpperCase()
    const where = f.lines.length ? ` (L${f.lines.slice(0, 3).join(', L')})` : ''
    const verified = f.origin === 'scan' ? ' · ✓verificado' : ''
    lines.push(`- [ ] ${i + 1}. **[${severity}]** ${f.title} — \`${f.file}\`${where}${verified}`)
  })
  lines.push('')

  findings.forEach((f, i) => {
    lines.push(`## ${i + 1}. ${f.title}`, '', '```text', buildFindingPrompt(f), '```', '')
  })

  lines.push(
    '---',
    '_Cómo re-auditar: `bun cli.ts <carpeta>` (determinista) o vuelve a auditar el repo en tu instancia de VibeCheck._',
    '_Generado con VibeCheck · Open Source (MIT)_',
  )
  return lines.join('\n')
}
