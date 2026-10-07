'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { SAMPLES, type Sample } from '@/lib/samples'
import {
  LANGUAGES,
  MAX_CODE_LENGTH,
  VERDICT_META,
  type AnalyzeResponse,
  type CheckHistoryItem,
  type VibeReport,
} from '@/lib/vibe-types'
import type { AnalyzeRepoResponse, RepoCheckHistoryItem, RepoReport } from '@/lib/repo-types'
import { parseRepoStreamLine } from '@/lib/stream-client'
import { MiniRing } from '@/components/vibe/score-gauge'
import { ReportView } from '@/components/vibe/report-view'
import { RepoReportView } from '@/components/vibe/repo-report-view'
import { ScanProgress, type LiveProgress } from '@/components/vibe/scan-progress'
import {
  Bug,
  Factory,
  FolderGit2,
  FolderSearch,
  Ghost,
  Github,
  Heart,
  Lock,
  Radar,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react'

type AnalyzerTab = 'github' | 'folder' | 'snippet'

const TERMINAL_LINES = [
  '$ vibecheck github.com/alguien/app-vibe-coded',
  '[🧪] 2 dependencias fantasma · 1 import roto',
  '[🔒] .env commiteado + 2 secretos hardcodeados',
  '[👻] 5 llamadas a APIs que no existen',
  '[🤖] Señal: 3 archivos "por si acaso" que nadie importa',
  '✓ Reporte listo — Vibe Score: 31/100 · Veredicto: PELIGRO 🚨',
]

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'mp4', 'mp3', 'woff', 'woff2', 'ttf',
  'eot', 'otf', 'zip', 'tar', 'gz', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'exe',
  'dll', 'so', 'dylib', 'class', 'jar', 'pyc', 'wasm', 'map', 'db', 'lock',
])

const SKIP_PATH_RE =
  /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|vendor|__pycache__|\.venv|venv|target)(\/|$)/

function terminalLineClass(line: string): string {
  if (line.startsWith('$')) return 'text-emerald-400'
  if (line.startsWith('[🧪]')) return 'text-orange-400'
  if (line.startsWith('[🔒]')) return 'text-red-400'
  if (line.startsWith('[👻]')) return 'text-violet-400'
  if (line.startsWith('[🤖]')) return 'text-amber-400'
  if (line.startsWith('✓')) return 'text-emerald-300'
  return 'text-foreground/80'
}

function TypingTerminal() {
  const [progress, setProgress] = useState({ line: 0, char: 0 })

  useEffect(() => {
    const { line, char } = progress
    if (line >= TERMINAL_LINES.length) {
      const t = setTimeout(() => setProgress({ line: 0, char: 0 }), 4500)
      return () => clearTimeout(t)
    }
    const current = TERMINAL_LINES[line] ?? ''
    if (char < current.length) {
      const speed = current.startsWith('$') ? 60 : 13
      const t = setTimeout(() => setProgress({ line, char: char + 1 }), speed)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setProgress({ line: line + 1, char: 0 }), 300)
    return () => clearTimeout(t)
  }, [progress])

  const done = TERMINAL_LINES.slice(0, progress.line)
  const currentLine = TERMINAL_LINES[progress.line]?.slice(0, progress.char) ?? ''

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-zinc-950/90 shadow-2xl shadow-emerald-500/5"
      aria-label="Demo de VibeCheck en terminal"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <i className="block size-2.5 rounded-full bg-red-500/80" />
          <i className="block size-2.5 rounded-full bg-amber-500/80" />
          <i className="block size-2.5 rounded-full bg-emerald-500/80" />
        </span>
        <span className="ml-2 font-mono text-xs text-muted-foreground">vibecheck — zsh</span>
      </div>
      <div className="min-h-[190px] space-y-1.5 p-4 font-mono text-[13px] leading-6">
        {done.map((line, i) => (
          <p key={i} className={terminalLineClass(line)}>
            {line}
          </p>
        ))}
        {progress.line < TERMINAL_LINES.length && (
          <p className={terminalLineClass(TERMINAL_LINES[progress.line] ?? '')}>
            {currentLine}
            <span className="vibe-cursor ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-emerald-400" aria-hidden />
          </p>
        )}
      </div>
    </div>
  )
}

// ── Lectura de carpetas (input webkitdirectory + drag&drop) ──

async function readFilesList(fileList: File[]): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = []
  let total = 0
  for (const file of fileList) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    if (SKIP_PATH_RE.test(rel)) continue
    if (file.size > 40 * 1024) continue
    const ext = rel.split('.').pop()?.toLowerCase() ?? ''
    if (!ext || BINARY_EXT.has(ext)) continue
    if (out.length >= 300) break
    const text = await file.text()
    if (total + text.length > 900_000) break
    total += text.length
    out.push({ path: rel.replace(/^\.\//, ''), content: text })
  }
  return out
}

async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const files: File[] = []
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        ;(entry as FileSystemFileEntry).file(
          (f) => {
            try {
              Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name })
            } catch {
              /* ignore */
            }
            files.push(f)
            resolve()
          },
          () => resolve(),
        )
      })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      const readAll = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve) => {
          reader.readEntries(async (entries) => {
            if (entries.length === 0) return resolve([])
            const rest = await readAll()
            resolve([...entries, ...rest])
          }, () => resolve([]))
        })
      const children = await readAll()
      for (const c of children) await walk(c, `${prefix}${entry.name}/`)
    }
  }
  const entries = [...dt.items]
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => Boolean(e))
  for (const e of entries) await walk(e, '')
  return files
}

// ── Historial unificado ───────────────────────────────────────

type AnyHistoryItem =
  | ({ kind: 'snippet' } & CheckHistoryItem)
  | ({ kind: 'repo' } & RepoCheckHistoryItem)

export default function Home() {
  const { toast } = useToast()
  const [tab, setTab] = useState<AnalyzerTab>('github')
  const [code, setCode] = useState('')
  const [language, setLanguage] = useState('auto')
  const [title, setTitle] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [pickedFiles, setPickedFiles] = useState<{ path: string; content: string }[]>([])
  const [pickedName, setPickedName] = useState('')
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<VibeReport | null>(null)
  const [reportTitle, setReportTitle] = useState('')
  const [repoReport, setRepoReport] = useState<RepoReport | null>(null)
  const [live, setLive] = useState<LiveProgress | null>(null)
  const [history, setHistory] = useState<AnyHistoryItem[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const analyzerRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

  const fetchHistory = useCallback(async () => {
    try {
      const [snipRes, repoRes] = await Promise.all([fetch('/api/checks'), fetch('/api/repo-checks')])
      if (!snipRes.ok || !repoRes.ok) throw new Error('historial no disponible')
      const snipData = await snipRes.json()
      const repoData = await repoRes.json()
      const merged: AnyHistoryItem[] = [
        ...((snipData.checks ?? []) as CheckHistoryItem[]).map((c) => ({ kind: 'snippet' as const, ...c })),
        ...((repoData.repoChecks ?? []) as RepoCheckHistoryItem[]).map((c) => ({ kind: 'repo' as const, ...c })),
      ]
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setHistory(merged.slice(0, 20))
      setHistoryError(false)
    } catch {
      setHistory([])
      setHistoryError(true)
    }
  }, [])

  useEffect(() => {
    fetchHistory()
  }, [fetchHistory])

  const scrollToAnalyzer = () =>
    analyzerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const analyze = async () => {
    setLoading(true)
    setReport(null)
    setRepoReport(null)
    setLive(null)
    try {
      if (tab === 'github' || tab === 'folder') {
        const payload =
          tab === 'github'
            ? {
                source: 'github' as const,
                url: repoUrl.trim(),
                base: baseRef.trim() || undefined,
                token: ghToken.trim() || undefined,
              }
            : { source: 'files' as const, title: pickedName || undefined, files: pickedFiles }
        if (tab === 'github' && !/github\.com\/[^/\s]+\/[^/\s]+/.test(repoUrl.trim())) {
          throw new Error('Ingresa una URL válida: https://github.com/owner/repo')
        }
        if (tab === 'folder' && pickedFiles.length === 0) {
          throw new Error('Selecciona o arrastra una carpeta con código primero.')
        }
        const res = await fetch('/api/analyze-repo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(payload),
        })

        if (res.headers.get('content-type')?.includes('x-ndjson') && res.body) {
          // Progreso real: eventos NDJSON línea a línea
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const ev = parseRepoStreamLine(line)
              if (!ev) continue
              if (ev.type === 'progress') {
                setLive({ phase: ev.phase, pct: ev.pct, message: ev.message })
              } else if (ev.type === 'error') {
                throw new Error(ev.error)
              } else {
                setRepoReport(ev.report)
                toast({
                  title: `${VERDICT_META[ev.report.verdict].emoji} ${ev.report.repoName} — Vibe Score: ${ev.report.score}/100`,
                  description: ev.cached
                    ? 'Resultado servido desde caché — sin costo de IA'
                    : `Veredicto: ${ev.report.verdict}`,
                })
              }
            }
          }
        } else {
          // Respuesta JSON plana (400/429/500 o proxy sin streaming)
          const data = (await res.json()) as AnalyzeRepoResponse & { error?: string }
          if (!res.ok || data.error) throw new Error(data.error || 'Error del servidor')
          setRepoReport(data.report)
          toast({
            title: `${VERDICT_META[data.report.verdict].emoji} ${data.report.repoName} — Vibe Score: ${data.report.score}/100`,
            description: `Veredicto: ${data.report.verdict}`,
          })
        }
      } else {
        if (code.trim().length < 10) {
          throw new Error('Pega al menos unas líneas para auditar (mínimo 10 caracteres).')
        }
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, language, title: title || undefined }),
        })
        const data = (await res.json()) as AnalyzeResponse & { error?: string }
        if (!res.ok || data.error) throw new Error(data.error || 'Error del servidor')
        setReport(data.report)
        setReportTitle(title || 'Snippet sin título')
        toast({
          title: `${VERDICT_META[data.report.verdict].emoji} Auditoría lista — Vibe Score: ${data.report.score}/100`,
          description: `Veredicto: ${data.report.verdict}`,
        })
      }
      fetchHistory()
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } catch (e) {
      toast({
        title: 'La auditoría falló',
        description: e instanceof Error ? e.message : 'Error desconocido',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      setLive(null)
    }
  }

  const loadSample = (s: Sample) => {
    setTab('snippet')
    setCode(s.code)
    setLanguage(s.language)
    setTitle(s.title)
    setRepoReport(null)
    toast({ title: `${s.emoji} Ejemplo cargado: ${s.label}`, description: s.description })
    analyzerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const loadSnippetCheck = async (id: string) => {
    try {
      const res = await fetch(`/api/checks/${id}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setReport(data.report as VibeReport)
      setReportTitle(data.title ?? 'Auditoría guardada')
      setCode('')
      setRepoReport(null)
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } catch {
      toast({ title: 'No se pudo cargar la auditoría', variant: 'destructive' })
    }
  }

  const loadRepoCheck = async (id: string) => {
    try {
      const res = await fetch(`/api/repo-checks/${id}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setRepoReport(data.report as RepoReport)
      setReport(null)
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } catch {
      toast({ title: 'No se pudo cargar la auditoría', variant: 'destructive' })
    }
  }

  const deleteItem = async (item: AnyHistoryItem) => {
    setHistory((h) => h.filter((c) => c.id !== item.id))
    try {
      await fetch(`/api/${item.kind === 'snippet' ? 'checks' : 'repo-checks'}/${item.id}`, {
        method: 'DELETE',
      })
    } catch {
      fetchHistory()
    }
  }

  const onFolderInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    const picked = await readFilesList(files)
    setPickedFiles(picked)
    const root = files[0]?.webkitRelativePath?.split('/')[0] ?? 'carpeta'
    setPickedName(root)
    toast({
      title: `📁 Carpeta lista: ${root}`,
      description: `${picked.length} archivos legibles para auditar`,
    })
  }

  const onDropFolder = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const dt = e.dataTransfer
    const files = dt.items?.length ? await filesFromDataTransfer(dt) : Array.from(dt.files ?? [])
    if (files.length === 0) return
    const picked = await readFilesList(files)
    if (picked.length === 0) {
      toast({ title: 'No hay archivos audibles', description: '¿Solo binarios o node_modules?', variant: 'destructive' })
      return
    }
    setPickedFiles(picked)
    const root = picked[0]?.path.split('/')[0] ?? 'carpeta'
    setPickedName(root)
    toast({ title: `📁 Carpeta lista: ${root}`, description: `${picked.length} archivos legibles` })
  }

  const lines = code ? code.split('\n').length : 0
  const analyzeLabel =
    tab === 'github' ? 'Auditar repo con IA' : tab === 'folder' ? 'Auditar carpeta con IA' : 'Auditar con IA'

  return (
    <div className="dark flex min-h-screen flex-col bg-zinc-950 text-foreground">
      {/* fondo decorativo */}
      <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden>
        <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.035)_1px,transparent_1px)] bg-[size:44px_44px]" />
        <div className="absolute -top-32 left-1/4 size-[420px] rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-32 size-[380px] rounded-full bg-violet-500/10 blur-[120px]" />
        <div className="absolute bottom-0 -left-32 size-[360px] rounded-full bg-emerald-600/5 blur-[120px]" />
      </div>

      {/* ── Header ──────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-zinc-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <a href="#" className="flex items-center gap-2.5" aria-label="VibeCheck inicio">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-lg shadow-emerald-500/20">
              <Radar className="size-4.5 text-white" aria-hidden />
            </span>
            <span className="text-lg font-bold tracking-tight">
              Vibe<span className="text-emerald-400">Check</span>
            </span>
            <Badge variant="outline" className="ml-1 hidden border-emerald-500/40 text-[10px] text-emerald-400 sm:inline-flex">
              open source · MIT
            </Badge>
          </a>
          <nav className="flex items-center gap-1" aria-label="Navegación principal">
            <Button variant="ghost" size="sm" className="hidden text-muted-foreground sm:inline-flex" onClick={scrollToAnalyzer}>
              Analizador
            </Button>
            <a
              href="https://github.com/tiagofur/vibe-check"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Github className="size-4" aria-hidden /> GitHub
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero ─────────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 pb-16 pt-14 sm:pt-20">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div className="space-y-6">
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                  ⚡ due diligence de repos en la era del vibe coding
                </Badge>
                <h1 className="mt-4 text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl">
                  ¿Ese repo lo escribió una IA?
                  <span className="mt-2 block bg-gradient-to-r from-emerald-400 via-amber-300 to-violet-400 bg-clip-text text-transparent">
                    Descúbrelo antes de clonar.
                  </span>
                </h1>
                <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                  VibeCheck audita <span className="font-medium text-foreground">repositorios completos</span> (públicos
                  de GitHub o tu carpeta local) con un motor determinista que mapea el grafo de imports y un auditor IA
                  adversarial: detecta <span className="text-emerald-400">dependencias fantasma</span>,{' '}
                  <span className="text-violet-400">imports que apuntan a archivos que nunca existieron</span>,{' '}
                  <span className="text-red-400">secretos</span> y <span className="text-amber-400">sobre-ingeniería</span>.
                </p>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.15 }}
                className="flex flex-wrap items-center gap-3"
              >
                <Button size="lg" onClick={scrollToAnalyzer} className="gap-2 bg-emerald-600 text-base hover:bg-emerald-700">
                  <Github className="size-4" aria-hidden /> Auditar un repo
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => loadSample(SAMPLES[1] as Sample)}
                  className="gap-2 border-violet-500/40 text-base text-violet-300 hover:bg-violet-500/10 hover:text-violet-200"
                >
                  <Ghost className="size-4" aria-hidden /> Probar con una alucinación
                </Button>
              </motion.div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="Detectores incluidos">
                {[
                  { icon: Github, label: 'Repos públicos de GitHub' },
                  { icon: FolderGit2, label: 'Carpetas locales' },
                  { icon: Lock, label: 'Secretos & .env' },
                  { icon: Ghost, label: 'Alucinaciones cross-file' },
                  { icon: Bug, label: 'Tests falsos' },
                  { icon: Factory, label: 'Sobre-ingeniería' },
                ].map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1.5">
                    <Icon className="size-3.5 text-emerald-400" aria-hidden /> {label}
                  </span>
                ))}
              </div>
            </div>
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <TypingTerminal />
            </motion.div>
          </div>
        </section>

        {/* ── Analizador ───────────────────────────────────── */}
        <section ref={analyzerRef} className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10" aria-label="Analizador de código">
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.5 }}>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  El analizador <span className="text-emerald-400">/</span> La prueba de realidad
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Un repo público, una carpeta local o un snippet suelto. Sin cuentas, sin límites artificiales.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {SAMPLES.map((s) => (
                  <Button
                    key={s.id}
                    variant="outline"
                    size="sm"
                    onClick={() => loadSample(s)}
                    className="gap-1.5 border-dashed text-xs"
                    title={s.description}
                  >
                    <span aria-hidden>{s.emoji}</span> {s.label}
                  </Button>
                ))}
              </div>
            </div>

            <Card className="border-border bg-zinc-900/60">
              <CardContent className="space-y-4 p-4 sm:p-6">
                <Tabs value={tab} onValueChange={(v) => setTab(v as AnalyzerTab)}>
                  <TabsList className="grid w-full grid-cols-3 bg-zinc-950/60">
                    <TabsTrigger value="github" className="gap-1.5 text-xs sm:text-sm">
                      <Github className="size-4" aria-hidden /> Repo GitHub
                    </TabsTrigger>
                    <TabsTrigger value="folder" className="gap-1.5 text-xs sm:text-sm">
                      <FolderGit2 className="size-4" aria-hidden /> Carpeta local
                    </TabsTrigger>
                    <TabsTrigger value="snippet" className="gap-1.5 text-xs sm:text-sm">
                      <Sparkles className="size-4" aria-hidden /> Snippet
                    </TabsTrigger>
                  </TabsList>

                  {/* GitHub */}
                  <TabsContent value="github" className="mt-4 space-y-3">
                    <Input
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/owner/repo  (o …/tree/rama)"
                      className="bg-zinc-950/60 font-mono text-sm"
                      aria-label="URL del repositorio de GitHub"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !loading) analyze()
                      }}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        value={baseRef}
                        onChange={(e) => setBaseRef(e.target.value)}
                        placeholder="🔀 Modo diff (opcional): v1.2.0 — audita solo los cambios desde este tag/rama/sha"
                        className="bg-zinc-950/60 font-mono text-xs"
                        aria-label="Ref base para modo diff"
                      />
                      <Input
                        type="password"
                        value={ghToken}
                        onChange={(e) => setGhToken(e.target.value)}
                        placeholder="🔑 Token PAT (opcional, repos privados) — nunca se guarda"
                        className="bg-zinc-950/60 font-mono text-xs"
                        aria-label="Token de acceso personal de GitHub"
                        autoComplete="off"
                      />
                    </div>
                    <div className="rounded-lg border border-border bg-zinc-950/40 p-3 text-xs leading-relaxed text-muted-foreground">
                      <p className="flex flex-wrap gap-x-4 gap-y-1">
                        <span>🐙 <span className="text-foreground/80">Públicos y privados</span> — privados con token scope repo (o GITHUB_TOKEN en el servidor)</span>
                        <span>🧠 Triage: los {`~30`} archivos de mayor riesgo se auditan a fondo</span>
                        <span>🧪 Grafo de imports sobre el árbol completo</span>
                      </p>
                      <p className="mt-2">
                        Prueba con algo pequeño primero:{' '}
                        <button
                          onClick={() => setRepoUrl('https://github.com/sindresorhus/slugify')}
                          className="font-mono text-emerald-400 underline-offset-2 hover:underline"
                        >
                          sindresorhus/slugify
                        </button>{' '}
                        ·{' '}
                        <button
                          onClick={() => setRepoUrl('https://github.com/sindresorhus/pretty-bytes')}
                          className="font-mono text-emerald-400 underline-offset-2 hover:underline"
                        >
                          sindresorhus/pretty-bytes
                        </button>
                      </p>
                    </div>
                  </TabsContent>

                  {/* Carpeta local */}
                  <TabsContent value="folder" className="mt-4 space-y-3">
                    <div
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDragOver(true)
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={onDropFolder}
                      className={`flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-zinc-950/40 px-4 py-10 text-center transition-colors ${dragOver ? 'border-emerald-500/60 bg-emerald-500/5' : ''}`}
                    >
                      <FolderSearch className={`size-9 ${dragOver ? 'text-emerald-400' : 'text-muted-foreground/50'}`} aria-hidden />
                      <div>
                        <p className="text-sm font-medium">
                          Arrastra una <span className="text-emerald-400">carpeta</span> aquí
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Se ignoran node_modules, .git, binarios y archivos &gt; 40 KB · máx. 300 archivos
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => folderInputRef.current?.click()}
                        className="gap-2"
                      >
                        <Upload className="size-3.5" aria-hidden /> Elegir carpeta…
                      </Button>
                      <input
                        ref={folderInputRef}
                        type="file"
                        multiple
                        onChange={onFolderInput}
                        className="hidden"
                        aria-label="Seleccionar carpeta"
                      />
                      {pickedFiles.length > 0 && (
                        <div className="mt-1 w-full max-w-md rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-left">
                          <p className="text-xs font-semibold text-emerald-400">
                            📁 {pickedName} — {pickedFiles.length} archivos ·{' '}
                            {(pickedFiles.reduce((n, f) => n + f.content.length, 0) / 1024).toFixed(0)} KB
                          </p>
                          <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                            {pickedFiles.slice(0, 3).map((f) => f.path).join(' · ')}
                            {pickedFiles.length > 3 ? ' · …' : ''}
                          </p>
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  {/* Snippet */}
                  <TabsContent value="snippet" className="mt-4 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
                      <Input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Nombre del snippet (opcional) — ej. checkout-service.ts"
                        maxLength={120}
                        className="bg-zinc-950/60"
                        aria-label="Nombre del snippet"
                      />
                      <Select value={language} onValueChange={setLanguage}>
                        <SelectTrigger className="bg-zinc-950/60" aria-label="Lenguaje del código">
                          <SelectValue placeholder="Lenguaje" />
                        </SelectTrigger>
                        <SelectContent>
                          {LANGUAGES.map((l) => (
                            <SelectItem key={l.value} value={l.value}>
                              {l.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDragOver(true)
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragOver(false)
                        const file = e.dataTransfer.files?.[0]
                        if (file) {
                          file.text().then((t) => {
                            setCode(t)
                            setTitle(file.name)
                          })
                        }
                      }}
                      className={`relative rounded-lg transition-colors ${dragOver ? 'ring-2 ring-emerald-500/60' : ''}`}
                    >
                      <Textarea
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="// Pega aquí tu código (incluso si lo escribió la IA a las 3 AM)…
// o arrastra un archivo .ts / .py / .js / .go …"
                        className="min-h-[200px] resize-y bg-zinc-950/60 font-mono text-[13px] leading-5 scrollbar-thin"
                        spellCheck={false}
                        aria-label="Código a auditar"
                      />
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      {lines} líneas · {code.length.toLocaleString('es-MX')} caracteres
                      {code.length > MAX_CODE_LENGTH && (
                        <span className="ml-2 text-amber-400">
                          se analizarán los primeros {MAX_CODE_LENGTH.toLocaleString('es-MX')}
                        </span>
                      )}
                    </p>
                  </TabsContent>
                </Tabs>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden />
                    Privacy by design: los contenidos de archivos nunca se guardan. Solo el reporte queda en tu instancia.
                  </p>
                  <Button
                    size="lg"
                    onClick={analyze}
                    disabled={loading || (tab === 'github' ? !repoUrl.trim() : tab === 'folder' ? pickedFiles.length === 0 : code.trim().length < 10)}
                    className="gap-2 bg-emerald-600 font-semibold hover:bg-emerald-700"
                  >
                    {loading ? (
                      <>
                        <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
                        Auditando…
                      </>
                    ) : (
                      <>
                        <Wand2 className="size-4" aria-hidden /> {analyzeLabel}
                      </>
                    )}
                  </Button>
                </div>

                {loading && (
                  <ScanProgress
                    mode={tab === 'folder' ? 'files' : tab}
                    language={tab === 'snippet' ? language : undefined}
                    live={tab === 'snippet' ? null : live}
                  />
                )}
              </CardContent>
            </Card>
          </motion.div>
        </section>

        {/* ── Resultados ───────────────────────────────────── */}
        <section ref={resultsRef} className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-6" aria-label="Resultados de la auditoría">
          {repoReport && <RepoReportView report={repoReport} onNewCheck={scrollToAnalyzer} />}
          {report && !repoReport && (
            <ReportView
              report={report}
              code={code}
              language={language === 'auto' ? 'auto-detectado' : language}
              title={reportTitle}
              onNewCheck={scrollToAnalyzer}
            />
          )}
        </section>

        {/* ── Historial ────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 py-10" aria-label="Historial de auditorías">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              Auditorías recientes <span className="text-muted-foreground">({history.length})</span>
            </h2>
            <Button variant="ghost" size="sm" onClick={fetchHistory} className="text-muted-foreground">
              Actualizar
            </Button>
          </div>
          {historyError ? (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <Radar className="size-8 text-amber-400/70" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-amber-300">Historial no disponible</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                    No se pudo leer la base de datos local. Revisa{' '}
                    <code className="font-mono text-xs text-foreground/80">DATABASE_URL</code> en tu{' '}
                    <code className="font-mono text-xs text-foreground/80">.env</code> y ejecuta{' '}
                    <code className="font-mono text-xs text-foreground/80">bun run db:push</code>.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchHistory}
                  className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                >
                  Reintentar
                </Button>
              </CardContent>
            </Card>
          ) : history.length === 0 ? (
            <Card className="border-dashed bg-zinc-900/40">
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <Radar className="size-8 text-muted-foreground/50" aria-hidden />
                <p className="text-sm text-muted-foreground">
                  Aún no hay auditorías en esta instancia. Empieza con un repo público pequeño.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {history.map((item) => {
                const verdict = VERDICT_META[item.verdict] ?? VERDICT_META.SOSPECHOSO
                const isRepo = item.kind === 'repo'
                const name = isRepo ? item.repoName : item.title
                return (
                  <Card
                    key={item.id}
                    className="group cursor-pointer bg-zinc-900/60 transition-colors hover:border-emerald-500/40"
                    onClick={() => (item.kind === 'repo' ? loadRepoCheck(item.id) : loadSnippetCheck(item.id))}
                  >
                    <CardContent className="flex items-center gap-3 p-4">
                      <div className="relative">
                        <MiniRing score={item.score} size={48} />
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-xs font-bold">
                          {item.score}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {isRepo ? (
                            item.source === 'github' ? (
                              <Github className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                            ) : (
                              <FolderGit2 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                            )
                          ) : (
                            <Sparkles className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <p className="truncate text-sm font-medium" title={name}>
                            {name}
                          </p>
                        </div>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {isRepo && item.branch && <span className="font-mono">{item.branch}</span>}
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true, locale: es })}
                        </p>
                        <Badge variant="outline" className={`mt-1.5 text-[10px] ${verdict.classes}`}>
                          {verdict.emoji} {item.verdict}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteItem(item)
                        }}
                        aria-label={`Eliminar auditoría ${name}`}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Cómo funciona ────────────────────────────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 py-10" aria-label="Cómo funciona">
          <h2 className="mb-6 text-xl font-bold tracking-tight sm:text-2xl">Cómo funciona el modo repo</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                n: '01',
                title: 'Descarga + grafo de imports',
                body: 'Se recorre el árbol del repo, se leen los archivos de código y se construye el grafo de imports vs manifiesto: 100% determinista, cero LLM.',
              },
              {
                n: '02',
                title: 'Triage adversarial',
                body: 'Los archivos se rankean por riesgo (auth > pagos > secrets > DB > API) y los ~30 más calientes se auditan con IA en lotes, buscando alucinaciones cross-file y tests falsos.',
              },
              {
                n: '03',
                title: 'Veredicto con evidencia',
                body: 'Chequeos estructurales reproducibles + hallazgos IA con línea y fix, señales de vibe coding y un Vibe Score con techo duro: un crítico de seguridad te clava el score.',
              },
            ].map((s, i) => (
              <motion.div
                key={s.n}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.1 }}
              >
                <Card className="h-full bg-zinc-900/60">
                  <CardContent className="p-5">
                    <span className="bg-gradient-to-br from-emerald-400 to-violet-400 bg-clip-text font-mono text-3xl font-extrabold text-transparent">
                      {s.n}
                    </span>
                    <h3 className="mt-2 font-semibold">{s.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>
      </main>

      {/* ── Footer (sticky al fondo) ────────────────────────── */}
      <footer className="mt-auto border-t border-border/60 bg-zinc-950/80 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-emerald-500 to-emerald-700">
                <Radar className="size-4 text-white" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold">
                  Vibe<span className="text-emerald-400">Check</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Hecho con <Heart className="inline size-3 text-red-400" aria-hidden /> para la comunidad · MIT License
                </p>
              </div>
            </div>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground" aria-label="Enlaces del proyecto">
              <a
                href="https://github.com/tiagofur/vibe-check"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
              >
                <Github className="size-4" aria-hidden /> Repositorio
              </a>
              <a
                href="https://github.com/tiagofur/vibe-check/issues"
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-foreground"
              >
                Issues
              </a>
              <a
                href="https://github.com/tiagofur/vibe-check#contribuir"
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-foreground"
              >
                Contribuir
              </a>
            </nav>
          </div>
          <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground/70">
            Las auditorías son asistidas por IA y pueden contener errores: no sustituyen una code review humana.
            VibeCheck es 100% open source — clona, audita y mejora al auditor.
          </p>
        </div>
      </footer>
    </div>
  )
}
