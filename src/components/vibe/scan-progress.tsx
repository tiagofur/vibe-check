'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bug,
  Factory,
  FileSearch,
  Ghost,
  Github,
  GitBranch,
  Lock,
  Radar,
  Sparkles,
  Code2,
  FolderGit2,
  Zap,
  Database,
} from 'lucide-react'

type ScanMode = 'snippet' | 'github' | 'files'

/** Progreso real emitido por el backend (NDJSON) */
export interface LiveProgress {
  phase: string
  pct: number
  message: string
}

const STEPS_BY_MODE: Record<ScanMode, { icon: typeof Code2; text: string }[]> = {
  snippet: [
    { icon: Code2, text: 'Leyendo la estructura del código…' },
    { icon: Lock, text: 'Escaneando secretos y vulnerabilidades…' },
    { icon: Ghost, text: 'Cazando alucinaciones de la IA…' },
    { icon: Radar, text: 'Verificando APIs y paquetes contra el mundo real…' },
    { icon: Bug, text: 'Detectando bugs lógicos y edge cases…' },
    { icon: Factory, text: 'Midiendo el nivel de sobre-ingeniería…' },
    { icon: Sparkles, text: 'Calculando tu Vibe Score…' },
  ],
  github: [
    { icon: Github, text: 'Descargando el árbol del repositorio…' },
    { icon: FileSearch, text: 'Leyendo manifiesto y grafo de imports…' },
    { icon: Lock, text: 'Escaneo estructural: secretos, .env, dependencias fantasma…' },
    { icon: Radar, text: 'Priorizando archivos de mayor riesgo…' },
    { icon: Bug, text: 'Auditando los archivos críticos con IA…' },
    { icon: Ghost, text: 'Correlacionando alucinaciones entre archivos…' },
    { icon: Sparkles, text: 'Redactando el veredicto del repo…' },
  ],
  files: [
    { icon: FolderGit2, text: 'Recorriendo la carpeta y leyendo archivos…' },
    { icon: FileSearch, text: 'Leyendo manifiesto y grafo de imports…' },
    { icon: Lock, text: 'Escaneo estructural: secretos, .env, dependencias fantasma…' },
    { icon: Radar, text: 'Priorizando archivos de mayor riesgo…' },
    { icon: Bug, text: 'Auditando los archivos críticos con IA…' },
    { icon: Ghost, text: 'Correlacionando alucinaciones entre archivos…' },
    { icon: Sparkles, text: 'Redactando el veredicto del repo…' },
  ],
}

/** Fase del backend → icono del panel de progreso */
const PHASE_ICON: Record<string, typeof Code2> = {
  descarga: Github,
  estructura: FileSearch,
  ia: Bug,
  sintesis: Sparkles,
  cache: Zap,
  guardado: Database,
}

export function ScanProgress({
  mode,
  language,
  live,
}: {
  mode: ScanMode
  language?: string
  live?: LiveProgress | null
}) {
  const STEPS = STEPS_BY_MODE[mode] ?? STEPS_BY_MODE.snippet
  const [step, setStep] = useState(0)

  const isLive = Boolean(live)

  useEffect(() => {
    // con progreso real no hace falta el carrusel ficticio
    if (isLive) return
    const id = setInterval(() => {
      setStep((s) => (s + 1) % STEPS.length)
    }, mode === 'snippet' ? 2600 : 4200)
    return () => clearInterval(id)
  }, [STEPS.length, mode, isLive])

  const PhaseIcon = live ? PHASE_ICON[live.phase] ?? Radar : undefined
  const Icon = PhaseIcon ?? STEPS[step]?.icon ?? Radar
  const pct = live ? Math.min(100, Math.max(0, live.pct)) : null

  return (
    <div
      className="rounded-xl border border-emerald-500/25 bg-zinc-900/70 p-5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-4">
        <div className="relative flex size-11 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
          <AnimatePresence mode="wait">
            <motion.span
              key={live ? live.phase : step}
              initial={{ opacity: 0, scale: 0.6, rotate: -20 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.6, rotate: 20 }}
              transition={{ duration: 0.25 }}
              className="text-emerald-400"
            >
              <Icon className="size-5" aria-hidden />
            </motion.span>
          </AnimatePresence>
          <span className="absolute inset-0 animate-ping rounded-lg border border-emerald-500/30" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">
              {mode === 'snippet' ? 'Auditoría en curso' : 'Auditoría de repo en curso'}
            </p>
            {language && (
              <p className="font-mono text-[11px] text-muted-foreground">{language}</p>
            )}
          </div>
          <AnimatePresence mode="wait">
            <motion.p
              key={live ? live.message : step}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22 }}
              className="truncate text-sm text-muted-foreground"
            >
              {live ? live.message : (STEPS[step]?.text ?? 'Analizando…')}
            </motion.p>
          </AnimatePresence>
          <div className="mt-3 flex items-center gap-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              {pct !== null ? (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-emerald-500 transition-all duration-700"
                  style={{ width: `${pct}%` }}
                />
              ) : (
                <div className="vibe-scan-bar h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-emerald-500" />
              )}
            </div>
            {pct !== null && (
              <span className="w-9 shrink-0 text-right font-mono text-[11px] text-emerald-400">
                {pct}%
              </span>
            )}
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-muted-foreground">
        {mode === 'snippet'
          ? 'La IA está leyendo tu código línea por línea — puede tardar entre 15 y 60 segundos ☕'
          : 'El motor determinista mapea el repo completo y la IA audita a fondo los archivos de mayor riesgo — entre 30 y 120 segundos ☕'}
      </p>
      {mode !== 'snippet' && (
        <p className="mt-1 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
          <GitBranch className="size-3" aria-hidden /> grafo de imports + triage por riesgo + lotes de IA
        </p>
      )}
    </div>
  )
}
