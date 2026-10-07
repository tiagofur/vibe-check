'use client'

import { useMemo, useRef, useState } from 'react'
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
  type Finding,
  type VibeReport,
} from '@/lib/vibe-types'
import { ScoreGauge, MiniRing } from '@/components/vibe/score-gauge'
import { Check, Copy, FileCode2, Wrench } from 'lucide-react'

const CATEGORY_ORDER: CategoryKey[] = ['security', 'hallucination', 'bugs', 'overengineering']

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
}

function buildMarkdownReport(report: VibeReport, title: string, language: string): string {
  const lines: string[] = [
    `# 🔍 VibeCheck — ${title}`,
    '',
    `**Vibe Score:** ${report.score}/100 · **Veredicto:** ${report.verdict} · **Lenguaje:** ${language}`,
    '',
    `${report.summary}`,
    '',
  ]
  for (const key of CATEGORY_ORDER) {
    const cat = report.categories[key]
    lines.push(`## ${CATEGORY_META[key].icon} ${CATEGORY_META[key].label} — ${cat.score}/100`)
    lines.push(`_${cat.summary}_`)
    if (cat.findings.length === 0) {
      lines.push('- ✅ Sin hallazgos')
    } else {
      for (const f of cat.findings) {
        lines.push(`- **[${SEVERITY_META[f.severity].label}] ${f.title}** (líneas ${f.lines.join(', ') || 'n/a'})`)
        lines.push(`  - ${f.explanation}`)
        lines.push(`  - 🛠 Fix: ${f.fix}`)
      }
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('_Generado con VibeCheck · Open Source (MIT)_')
  return lines.join('\n')
}

interface ReportViewProps {
  report: VibeReport
  code: string
  language: string
  title: string
  onNewCheck: () => void
}

export function ReportView({ report, code, language, title, onNewCheck }: ReportViewProps) {
  const { toast } = useToast()
  const codeRef = useRef<HTMLDivElement>(null)
  const [focusedLine, setFocusedLine] = useState<number | null>(null)

  const lineSeverity = useMemo(() => {
    const map = new Map<number, string>()
    for (const key of CATEGORY_ORDER) {
      for (const f of report.categories[key].findings) {
        for (const l of f.lines) {
          const prev = map.get(l)
          if (prev === undefined || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev]) {
            map.set(l, f.severity)
          }
        }
      }
    }
    return map
  }, [report])

  const codeLines = useMemo(() => (code ? code.split('\n') : []), [code])

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdownReport(report, title, language))
      toast({ title: '📋 Reporte copiado', description: 'Pégalo en tu PR, issue o Discord.' })
    } catch {
      toast({ title: 'No se pudo copiar', variant: 'destructive' })
    }
  }

  const scrollToLine = (line: number) => {
    setFocusedLine(line)
    const el = codeRef.current?.querySelector(`[data-line="${line}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const verdict = VERDICT_META[report.verdict]

  return (
    <div className="space-y-6">
      {/* ── Veredicto principal ─────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <Card className="border-emerald-500/20 bg-zinc-900/60">
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-center lg:gap-12">
              <ScoreGauge score={report.score} />
              <div className="flex-1 space-y-4 text-center lg:text-left">
                <Badge variant="outline" className={`${verdict.classes} text-sm font-semibold px-4 py-1.5`}>
                  {verdict.emoji} {report.verdict}
                </Badge>
                <p className="text-lg font-medium text-foreground">{verdict.message}</p>
                <p className="text-sm leading-relaxed text-muted-foreground">{report.summary}</p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1 lg:justify-start">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {language}
                  </Badge>
                  {codeLines.length > 0 && (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {codeLines.length} líneas
                    </Badge>
                  )}
                  <Button size="sm" variant="outline" onClick={copyReport} className="gap-1.5">
                    <Copy className="size-3.5" /> Copiar reporte MD
                  </Button>
                  <Button size="sm" onClick={onNewCheck} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
                    <FileCode2 className="size-3.5" /> Nueva auditoría
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Tarjetas por categoría ──────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CATEGORY_ORDER.map((key, i) => {
          const cat = report.categories[key]
          const meta = CATEGORY_META[key]
          const clean = cat.findings.length === 0
          return (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 + i * 0.08 }}
            >
              <Card
                className={`h-full bg-zinc-900/60 transition-colors ${clean ? 'border-emerald-500/25' : 'border-border hover:border-emerald-500/30'}`}
              >
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
                    <button
                      onClick={() => {
                        document
                          .getElementById(`cat-${key}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                      className="mt-auto inline-flex w-fit items-center gap-1 text-xs font-medium text-emerald-400 underline-offset-4 hover:underline"
                    >
                      Ver {cat.findings.length} hallazgo{cat.findings.length !== 1 ? 's' : ''} ↓
                    </button>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )
        })}
      </div>

      {/* ── Hallazgos por categoría ─────────────────────────── */}
      {CATEGORY_ORDER.map((key) => {
        const cat = report.categories[key]
        if (cat.findings.length === 0) return null
        const meta = CATEGORY_META[key]
        const sorted = [...cat.findings].sort(
          (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
        )
        return (
          <motion.div
            key={key}
            id={`cat-${key}`}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.4 }}
            className="scroll-mt-24"
          >
            <Card className="bg-zinc-900/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <span aria-hidden>{meta.icon}</span> {meta.label}
                  <Badge variant="secondary" className="ml-1 font-mono text-xs">
                    {cat.findings.length}
                  </Badge>
                </CardTitle>
                <p className="text-sm text-muted-foreground">{cat.summary}</p>
              </CardHeader>
              <CardContent>
                <Accordion type="multiple" className="w-full">
                  {sorted.map((f, i) => {
                    const sev = SEVERITY_META[f.severity]
                    return (
                      <AccordionItem key={`${key}-${i}`} value={`${key}-${i}`}>
                        <AccordionTrigger className="gap-3 py-3 text-left hover:no-underline">
                          <span className="flex flex-1 flex-wrap items-center gap-2 pr-2">
                            <Badge variant="outline" className={`${sev.classes} shrink-0 text-[11px] font-semibold`}>
                              {sev.label}
                            </Badge>
                            <span className="text-sm font-medium">{f.title}</span>
                            {f.lines.length > 0 && (
                              <span className="flex flex-wrap gap-1">
                                {f.lines.slice(0, 4).map((l) => (
                                  <span
                                    key={l}
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      if (codeLines.length > 0) scrollToLine(l)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        if (codeLines.length > 0) scrollToLine(l)
                                      }
                                    }}
                                    className="cursor-pointer rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-400"
                                    title={`Ir a la línea ${l}`}
                                  >
                                    L{l}
                                  </span>
                                ))}
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
              </CardContent>
            </Card>
          </motion.div>
        )
      })}

      {/* ── Visor de código con líneas marcadas ─────────────── */}
      {codeLines.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.4 }}
        >
          <Card className="overflow-hidden bg-zinc-900/60">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="flex gap-1.5" aria-hidden>
                  <i className="block size-2.5 rounded-full bg-red-500/70" />
                  <i className="block size-2.5 rounded-full bg-amber-500/70" />
                  <i className="block size-2.5 rounded-full bg-emerald-500/70" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {title.slice(0, 50)} · {language}
                </span>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                {lineSeverity.size} líneas marcadas
              </span>
            </div>
            <div ref={codeRef} className="max-h-96 overflow-y-auto scrollbar-thin" role="figure" aria-label="Código analizado">
              <pre className="min-w-max py-2 font-mono text-xs leading-5">
                {codeLines.map((line, idx) => {
                  const n = idx + 1
                  const sev = lineSeverity.get(n)
                  const isFocused = focusedLine === n
                  return (
                    <div
                      key={n}
                      data-line={n}
                      className={`flex px-3 transition-colors ${
                        isFocused
                          ? 'bg-emerald-500/15'
                          : sev === 'critical'
                            ? 'bg-red-500/10'
                            : sev === 'high'
                              ? 'bg-orange-500/10'
                              : sev === 'medium'
                                ? 'bg-amber-500/5'
                                : 'hover:bg-muted/40'
                      }`}
                    >
                      <span
                        className={`w-10 shrink-0 select-none border-r pr-2 text-right ${
                          sev ? 'text-emerald-400/80 border-emerald-500/40' : 'text-muted-foreground/50 border-border'
                        }`}
                      >
                        {n}
                      </span>
                      <code className="whitespace-pre pl-3 text-foreground/90">{line || ' '}</code>
                    </div>
                  )
                })}
              </pre>
            </div>
          </Card>
        </motion.div>
      )}
    </div>
  )
}
