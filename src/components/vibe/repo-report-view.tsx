'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import {
  CATEGORY_META,
  SEVERITY_META,
  VERDICT_META,
  type CategoryKey,
} from '@/lib/vibe-types'
import type { RepoFinding, RepoReport, StructuralCheck } from '@/lib/repo-types'
import { ScoreGauge, MiniRing } from '@/components/vibe/score-gauge'
import {
  Check,
  Copy,
  FileCode2,
  FolderGit2,
  GitBranch,
  Github,
  Radar,
  Siren,
  Star,
  TriangleAlert,
  Wrench,
  XCircle,
} from 'lucide-react'

const CATEGORY_ORDER: CategoryKey[] = ['security', 'hallucination', 'bugs', 'overengineering']
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

function buildRepoMarkdown(report: RepoReport): string {
  const lines: string[] = [
    `# 🔍 VibeCheck Repo — ${report.repoName}`,
    '',
    `**Vibe Score:** ${report.score}/100 · **Veredicto:** ${report.verdict}` +
      (report.branch ? ` · **Rama:** ${report.branch}` : '') +
      (report.stars !== null ? ` · ⭐ ${report.stars}` : ''),
    '',
    `${report.summary}`,
    '',
    `## 🏗 Arquitectura`,
    `${report.architecture}`,
    '',
    `## 📊 Stats`,
    `- ${report.stats.filesScanned} archivos escaneados · ${report.stats.filesAudited} auditados con IA · ${report.stats.totalLines} líneas`,
    `- Lenguajes: ${report.stats.languages.join(', ') || 'n/d'}`,
    '',
    `## 🧪 Chequeos estructurales`,
  ]
  for (const c of report.structural) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'
    lines.push(`- ${icon} **${c.label}:** ${c.detail}`)
  }
  if (report.topRisks.length > 0) {
    lines.push('', '## 🚨 Riesgos principales')
    for (const r of report.topRisks) lines.push(`- **[${r.severity}] ${r.title}** — ${r.detail}`)
  }
  if (report.vibeSignals.length > 0) {
    lines.push('', '## 🤖 Señales de vibe coding')
    for (const s of report.vibeSignals) lines.push(`- **${s.title}** — ${s.detail}`)
  }
  for (const key of CATEGORY_ORDER) {
    const cat = report.categories[key]
    lines.push('', `## ${CATEGORY_META[key].icon} ${CATEGORY_META[key].label} — ${cat.score}/100`)
    lines.push(`_${cat.summary}_`)
    if (cat.findings.length === 0) {
      lines.push('- ✅ Sin hallazgos')
    } else {
      for (const f of cat.findings) {
        lines.push(
          `- **[${SEVERITY_META[f.severity].label}] ${f.title}** · \`${f.file}\`${f.lines.length ? ` (líneas ${f.lines.join(', ')})` : ''}`,
        )
        lines.push(`  - ${f.explanation}`)
        lines.push(`  - 🛠 Fix: ${f.fix}`)
      }
    }
  }
  lines.push('', '---', '_Generado con VibeCheck · Open Source (MIT)_')
  return lines.join('\n')
}

function CheckBadge({ check }: { check: StructuralCheck }) {
  const cls =
    check.status === 'pass'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : check.status === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : 'border-red-500/30 bg-red-500/10 text-red-400'
  const Icon = check.status === 'pass' ? Check : check.status === 'warn' ? TriangleAlert : XCircle
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border p-3 ${cls}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-semibold">{check.label}</p>
        <p className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">{check.detail}</p>
      </div>
      {check.count > 0 && (
        <span className="ml-auto font-mono text-xs font-bold">{check.count}</span>
      )}
    </div>
  )
}

export function RepoReportView({
  report,
  onNewCheck,
}: {
  report: RepoReport
  onNewCheck: () => void
}) {
  const { toast } = useToast()
  const [fileFilter, setFileFilter] = useState<string | null>(null)

  const verdict = VERDICT_META[report.verdict]

  const findingsByFile = useMemo(() => {
    const map = new Map<string, RepoFinding[]>()
    for (const key of CATEGORY_ORDER) {
      for (const f of report.categories[key].findings) {
        const arr = map.get(f.file) ?? []
        arr.push(f)
        map.set(f.file, arr)
      }
    }
    return [...map.entries()]
      .map(([file, fs]) => ({
        file,
        findings: fs.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)),
        maxSeverity: fs.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity] ?? 0), 0),
      }))
      .sort((a, b) => b.maxSeverity - a.maxSeverity || a.file.localeCompare(b.file))
  }, [report])

  const visibleFiles = fileFilter
    ? findingsByFile.filter((f) => f.file === fileFilter)
    : findingsByFile

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildRepoMarkdown(report))
      toast({ title: '📋 Reporte copiado', description: 'Pégalo en tu PR, issue o Discord.' })
    } catch {
      toast({ title: 'No se pudo copiar', variant: 'destructive' })
    }
  }

  const structuralFails = report.structural.filter((c) => c.status === 'fail').length

  return (
    <div className="space-y-6">
      {/* ── Veredicto del repo ──────────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <Card className="border-emerald-500/20 bg-zinc-900/60">
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col items-center gap-8 lg:flex-row lg:gap-12">
              <ScoreGauge score={report.score} />
              <div className="min-w-0 flex-1 space-y-4 text-center lg:text-left">
                <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                  <Badge variant="outline" className={`${verdict.classes} px-4 py-1.5 text-sm font-semibold`}>
                    {verdict.emoji} {report.verdict}
                  </Badge>
                  {report.source === 'github' ? (
                    <Badge variant="outline" className="gap-1.5 border-border text-xs text-muted-foreground">
                      <Github className="size-3.5" aria-hidden /> repo público
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1.5 border-border text-xs text-muted-foreground">
                      <FolderGit2 className="size-3.5" aria-hidden /> carpeta local
                    </Badge>
                  )}
                  {report.stars !== null && (
                    <Badge variant="outline" className="gap-1.5 border-border text-xs text-muted-foreground">
                      <Star className="size-3.5 text-amber-400" aria-hidden /> {report.stars.toLocaleString('es-MX')}
                    </Badge>
                  )}
                </div>
                <h3 className="flex items-center justify-center gap-2 text-xl font-bold lg:justify-start">
                  {report.repoName}
                  {report.branch && (
                    <span className="inline-flex items-center gap-1 font-mono text-xs font-normal text-muted-foreground">
                      <GitBranch className="size-3.5" aria-hidden /> {report.branch}
                    </span>
                  )}
                </h3>
                <p className="text-lg font-medium text-foreground">{verdict.message}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">{report.summary}</p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1 lg:justify-start">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {report.stats.filesScanned} archivos escaneados
                  </Badge>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {report.stats.filesAudited} auditados con IA
                  </Badge>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {report.stats.totalLines.toLocaleString('es-MX')} líneas
                  </Badge>
                  {report.stats.languages.slice(0, 3).map((l) => (
                    <Badge key={l} variant="secondary" className="font-mono text-xs">
                      {l}
                    </Badge>
                  ))}
                  {report.stats.truncated && (
                    <Badge variant="outline" className="border-amber-500/40 text-xs text-amber-400">
                      árbol truncado
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1 lg:justify-start">
                  <Button size="sm" variant="outline" onClick={copyReport} className="gap-1.5">
                    <Copy className="size-3.5" /> Copiar reporte MD
                  </Button>
                  <Button size="sm" onClick={onNewCheck} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
                    <FileCode2 className="size-3.5" /> Auditar otro repo
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Chequeos estructurales ──────────────────────────── */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.08 }}>
        <Card className="bg-zinc-900/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              🧪 Chequeos estructurales
              {structuralFails > 0 && (
                <Badge variant="outline" className="border-red-500/40 text-xs text-red-400">
                  {structuralFails} fallando
                </Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Verificación determinista del grafo de imports y manifiesto — cero IA, 100% reproducible.
            </p>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {report.structural.map((c) => (
              <CheckBadge key={c.id} check={c} />
            ))}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Riesgos + señales + arquitectura ────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {report.topRisks.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.14 }}>
            <Card className="h-full border-red-500/20 bg-zinc-900/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Siren className="size-4 text-red-400" aria-hidden /> Riesgos principales
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {report.topRisks.map((r, i) => (
                  <div key={i} className="flex gap-2.5">
                    <span className={`mt-1.5 size-2 shrink-0 rounded-full ${SEVERITY_META[r.severity]?.dot ?? 'bg-zinc-500'}`} />
                    <div>
                      <p className="text-sm font-medium">{r.title}</p>
                      <p className="text-xs leading-relaxed text-muted-foreground">{r.detail}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        )}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.18 }}>
          <Card className="h-full bg-zinc-900/60">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Radar className="size-4 text-violet-400" aria-hidden /> ¿Huele a vibe coding?
              </CardTitle>
              <p className="text-sm text-muted-foreground">{report.architecture}</p>
            </CardHeader>
            {report.vibeSignals.length > 0 && (
              <CardContent className="space-y-2.5">
                {report.vibeSignals.map((s, i) => (
                  <div key={i} className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                    <p className="text-xs font-semibold text-violet-300">🤖 {s.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.detail}</p>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>
        </motion.div>
      </div>

      {/* ── Categorías ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CATEGORY_ORDER.map((key, i) => {
          const cat = report.categories[key]
          const meta = CATEGORY_META[key]
          const clean = cat.findings.length === 0
          return (
            <motion.div key={key} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.2 + i * 0.06 }}>
              <Card className={`h-full bg-zinc-900/60 ${clean ? 'border-emerald-500/25' : 'border-border'}`}>
                <CardContent className="flex h-full flex-col gap-3 p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-2xl" aria-hidden>{meta.icon}</span>
                    <div className="flex items-center gap-2">
                      <MiniRing score={cat.score} size={40} />
                      <span className="font-mono text-lg font-bold">{cat.score}</span>
                    </div>
                  </div>
                  <div>
                    <p className="font-semibold">{meta.label}</p>
                    <p className="text-xs text-muted-foreground">{meta.description}</p>
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{cat.summary}</p>
                  {clean ? (
                    <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                      <Check className="size-3.5" /> Sin hallazgos
                    </span>
                  ) : (
                    <span className="mt-auto text-xs font-medium text-muted-foreground">
                      {cat.findings.length} hallazgo{cat.findings.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )
        })}
      </div>

      {/* ── Hallazgos agrupados por archivo ─────────────────── */}
      {findingsByFile.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.26 }}>
          <Card className="bg-zinc-900/60">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">
                Hallazgos por archivo <span className="text-muted-foreground">({findingsByFile.length} archivos)</span>
              </CardTitle>
              {fileFilter && (
                <Button variant="ghost" size="sm" onClick={() => setFileFilter(null)} className="text-xs text-muted-foreground">
                  ✕ Quitar filtro: {fileFilter.split('/').pop()}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-5">
              {visibleFiles.map(({ file, findings }) => (
                <div key={file}>
                  <button
                    onClick={() => setFileFilter(file === fileFilter ? null : file)}
                    className="mb-1.5 flex items-center gap-2 font-mono text-xs text-emerald-400 transition-colors hover:text-emerald-300"
                    title="Filtrar por este archivo"
                  >
                    <FileCode2 className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{file}</span>
                    <span className="text-muted-foreground">({findings.length})</span>
                  </button>
                  <Accordion type="multiple" className="w-full">
                    {findings.map((f, i) => {
                      const sev = SEVERITY_META[f.severity]
                      return (
                        <AccordionItem key={`${file}-${i}`} value={`${file}-${i}`} className="border-border/60">
                          <AccordionTrigger className="gap-3 py-2.5 text-left hover:no-underline">
                            <span className="flex flex-1 flex-wrap items-center gap-2 pr-2">
                              <Badge variant="outline" className={`${sev.classes} shrink-0 text-[11px] font-semibold`}>
                                {sev.label}
                              </Badge>
                              {f.origin === 'scan' && (
                                <Badge variant="outline" className="shrink-0 border-emerald-500/40 text-[10px] text-emerald-400" title="Verificado determinísticamente">
                                  verificado
                                </Badge>
                              )}
                              <span className="text-sm font-medium">{f.title}</span>
                              {f.lines.length > 0 && (
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  L{f.lines.slice(0, 3).join(', L')}
                                </span>
                              )}
                            </span>
                          </AccordionTrigger>
                          <AccordionContent className="space-y-3 pb-4">
                            <p className="text-sm leading-relaxed text-muted-foreground">{f.explanation}</p>
                            <div className="flex gap-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                              <Wrench className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden />
                              <div>
                                <p className="text-xs font-semibold text-emerald-400">Fix sugerido</p>
                                <p className="mt-0.5 text-sm leading-relaxed text-foreground/90">{f.fix}</p>
                              </div>
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      )
                    })}
                  </Accordion>
                </div>
              ))}
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  )
}
