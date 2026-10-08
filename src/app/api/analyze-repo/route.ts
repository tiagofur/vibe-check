import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { clientKeyFrom, rateLimit } from '@/lib/rate-limit'
import {
  type RepoFile,
  type RepoFinding,
  type RepoReport,
  type StructuralCheck,
} from '@/lib/repo-types'
import {
  isScannablePath,
  riskScore,
  scanRepo,
} from '@/lib/repo-scan'
import { changedPaths, diffTrees, type TreeDiff } from '@/lib/repo-diff'
import { explainScore, mergeAndScore, verdictFromScore } from '@/lib/repo-score'
import { auditBatch, selectAuditFiles, synthesizeReport } from '@/lib/repo-llm'
import type { CategoryKey } from '@/lib/vibe-types'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_SCAN_FILES = 220
const MAX_FETCH_FILES = 120
const MAX_FILE_BYTES = 40 * 1024
const MAX_UPLOAD_FILES = 300
const MAX_UPLOAD_TOTAL = 900_000

const REPO_AUDITS_PER_HOUR = 10
const HOUR_MS = 60 * 60 * 1000

const bodySchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'),
    url: z.string().min(10).max(300),
    /** Modo diff: auditar solo los cambios desde este tag/rama/sha */
    base: z.string().trim().min(1).max(100).optional(),
    /** Token PAT (scope repo) para privados: se usa en esta petición y nunca se guarda */
    token: z.string().trim().min(10).max(255).optional(),
  }),
  z.object({
    source: z.literal('files'),
    title: z.string().max(140).optional(),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(300),
          content: z.string().max(MAX_FILE_BYTES * 2),
        }),
      )
      .min(1)
      .max(MAX_UPLOAD_FILES),
  }),
])

type Body = z.infer<typeof bodySchema>

type AuditPhase = 'descarga' | 'estructura' | 'ia' | 'sintesis' | 'cache' | 'guardado'

const CATEGORY_KEYS: CategoryKey[] = ['security', 'hallucination', 'bugs', 'overengineering']
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

// ── Eventos del stream de progreso (NDJSON) ────────────────

export type AuditStreamEvent =
  | { type: 'progress'; phase: AuditPhase; pct: number; message: string }
  | { type: 'done'; id: string; report: RepoReport; cached: boolean }
  | { type: 'error'; error: string }

type Emit = (event: AuditStreamEvent) => void

// ── GitHub (tarball: codeload anónimo o API con token para privados) ──

function parseGitHubUrl(url: string): { owner: string; repo: string; branch?: string } | null {
  const m = url.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/#?]+))?(?:[?#].*)?$/,
  )
  if (!m) return null
  return { owner: m[1] ?? '', repo: m[2] ?? '', branch: m[3] }
}

const HEAVY_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next',
  'vendor', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode',
])

/** Un ref puede ser tag, rama o sha: probamos las tres formas */
const refCandidates = (ref: string): string[] => [`refs/tags/${ref}`, `refs/heads/${ref}`, ref]

interface IngestResult {
  files: RepoFile[]
  repoName: string
  branch: string | null
  stars: number | null
  treeCount: number
  treePreview: string[]
  /** sha256 del contenido descargado: clave de caché */
  contentHash: string
  /** Presente en modo diff: cambios entre el ref base y el auditado */
  diff?: TreeDiff
  /** sha256 del árbol base (parte de la clave de caché en modo diff) */
  baseHash?: string
}

interface Tarball {
  buf: Buffer
  /** ref que funcionó, sin el prefijo refs/heads|tags/ */
  ref: string
}

async function fetchTarball(
  owner: string,
  repo: string,
  candidates: string[],
  token: string | undefined,
  label: string,
): Promise<Tarball> {
  const headers: Record<string, string> = { 'User-Agent': 'vibecheck-opensource-auditor' }
  if (token) headers.Authorization = `Bearer ${token}`
  const base = token
    ? `https://api.github.com/repos/${owner}/${repo}/tarball` // soporta repos privados
    : `https://codeload.github.com/${owner}/${repo}/tar.gz`

  for (const candidate of candidates) {
    const res = await fetch(`${base}/${candidate}`, {
      headers,
      signal: AbortSignal.timeout(45000),
    })
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 40 * 1024 * 1024) {
        throw new Error('El repo es demasiado grande para la auditoría gratuita (>40 MB comprimido).')
      }
      return { buf, ref: candidate.replace(/^refs\/(tags|heads)\//, '') }
    }
    if (res.status === 404) continue
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        token
          ? 'GitHub rechazó el token (¿inválido, sin scope repo, o rate limit?). Revisa el token e inténtalo en unos minutos.'
          : 'GitHub está limitando temporalmente las descargas. Inténtalo en unos minutos.',
      )
    }
    throw new Error(`GitHub respondió ${res.status} al descargar el repositorio.`)
  }
  throw new Error(
    `No se encontró ${label}${candidates[0] ? ` ("${candidates[0].replace(/^refs\/(tags|heads)\//, '')}")` : ''}. Si el repo es privado, proporciona un token con scope repo.`,
  )
}

/** Extrae el tarball y lee los archivos escaneables (con caps) */
async function extractAndRead(
  tarPath: string,
): Promise<{ files: RepoFile[]; treeCount: number; treePreview: string[] }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdtemp, writeFile, readdir, readFile, stat, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const pathMod = await import('node:path')
  const execFileAsync = promisify(execFile)
  const workDir = pathMod.dirname(tarPath)

  await execFileAsync('tar', ['-xzf', tarPath, '-C', workDir, '--no-same-owner'], { timeout: 45000 })
  const entries = await readdir(workDir)
  const top = entries.find((e) => e !== 'repo.tar.gz')
  if (!top) throw new Error('El archivo descargado del repo está vacío.')
  const rootDir = pathMod.join(workDir, top)

  // Recolecta archivos escaneables (validando rutas contra zip-slip)
  const all: { path: string; abs: string; size: number }[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const abs = pathMod.join(dir, item.name)
      const relPath = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (HEAVY_DIRS.has(item.name)) continue
        await walk(abs, relPath)
      } else if (item.isFile()) {
        const resolved = pathMod.resolve(abs)
        if (!resolved.startsWith(pathMod.resolve(rootDir))) continue
        const st = await stat(abs)
        all.push({ path: relPath, abs, size: st.size })
      }
    }
  }
  await walk(rootDir, '')

  const scannable = all
    .filter((f) => isScannablePath(f.path, f.size))
    .sort((a, b) => riskScore(b.path) - riskScore(a.path))
  const treeCount = scannable.length
  const treePreview = scannable.slice(0, 120).map((f) => f.path)
  const selected = scannable.slice(0, MAX_FETCH_FILES)

  const files: RepoFile[] = []
  for (const f of selected) {
    try {
      // truncado al leer: los archivos grandes aportan imports al grafo, no texto completo
      const content = (await readFile(f.abs, 'utf8')).slice(0, 64 * 1024)
      files.push({ path: f.path, content })
    } catch {
      /* archivo ilegible: se ignora */
    }
  }
  return { files, treeCount, treePreview }
}

async function writeTempTar(buf: Buffer): Promise<string> {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const pathMod = await import('node:path')
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'vibecheck-'))
  const tarPath = pathMod.join(dir, 'repo.tar.gz')
  await writeFile(tarPath, buf)
  return tarPath
}

async function ingestGitHub(url: string, emit: Emit, opts: { token?: string; base?: string }): Promise<IngestResult> {
  const parsed = parseGitHubUrl(url)
  if (!parsed || !parsed.owner || !parsed.repo) {
    throw new Error('URL de GitHub inválida. Formato esperado: https://github.com/owner/repo')
  }
  const token = opts.token || process.env.GITHUB_TOKEN || undefined
  const repoLabel = `${parsed.owner}/${parsed.repo}`

  emit({
    type: 'progress',
    phase: 'descarga',
    pct: 5,
    message: opts.base
      ? `Descargando ${repoLabel} (head + base ${opts.base}) desde GitHub…`
      : `Descargando ${repoLabel} desde GitHub…`,
  })

  const headCandidates = parsed.branch ? refCandidates(parsed.branch) : ['refs/heads/main', 'refs/heads/master']
  const head = await fetchTarball(parsed.owner, parsed.repo, headCandidates, token, 'el repo o la rama')
  const contentHash = createHash('sha256').update(head.buf).digest('hex')

  emit({ type: 'progress', phase: 'descarga', pct: 14, message: 'Descomprimiendo y leyendo el árbol del repo…' })
  const headTar = await writeTempTar(head.buf)
  let headTree: Awaited<ReturnType<typeof extractAndRead>>
  try {
    headTree = await extractAndRead(headTar)
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(headTar, { recursive: true, force: true })
  }

  if (headTree.files.length === 0) {
    throw new Error('El repo no contiene archivos de código auditable (¿solo binarios/documentación?).')
  }

  let diff: TreeDiff | undefined
  let baseHash: string | undefined

  // ── Modo diff: descargar el ref base y comparar árboles ──
  if (opts.base) {
    const baseTar = await fetchTarball(parsed.owner, parsed.repo, refCandidates(opts.base), token, `el ref base "${opts.base}"`)
    baseHash = createHash('sha256').update(baseTar.buf).digest('hex')
    emit({ type: 'progress', phase: 'descarga', pct: 20, message: `Descargando el ref base "${opts.base}" para el diff…` })
    const baseTarPath = await writeTempTar(baseTar.buf)
    let baseTree: Awaited<ReturnType<typeof extractAndRead>>
    try {
      baseTree = await extractAndRead(baseTarPath)
    } finally {
      const { rm } = await import('node:fs/promises')
      await rm(baseTarPath, { recursive: true, force: true })
    }
    diff = diffTrees(new Map(baseTree.files.map((f) => [f.path, f.content])), new Map(headTree.files.map((f) => [f.path, f.content])))
    emit({
      type: 'progress',
      phase: 'estructura',
      pct: 24,
      message: `Modo diff vs ${opts.base}: ${changedPaths(diff).size} archivos cambiados, ${diff.deleted.length} eliminados`,
    })
  }

  return {
    files: headTree.files,
    repoName: repoLabel,
    branch: head.ref,
    stars: null, // el tarball anónimo no expone metadatos; sin estrellas por ahora
    treeCount: headTree.treeCount,
    treePreview: headTree.treePreview,
    contentHash,
    diff,
    baseHash,
  }
}

function ingestFolder(body: Extract<Body, { source: 'files' }>): IngestResult {
  const files = body.files
    .filter((f) => isScannablePath(f.path, f.content.length))
    .map((f) => ({ path: f.path.replace(/^\.\//, ''), content: f.content }))
    .slice(0, MAX_SCAN_FILES)
  if (files.length === 0) {
    throw new Error('Ningún archivo de la carpeta es auditable (¿solo binarios o node_modules?).')
  }
  const contentHash = createHash('sha256')
    .update(files.map((f) => `${f.path}\u0000${f.content}`).join('\u0001'))
    .digest('hex')
  return {
    files,
    repoName: body.title?.trim() || 'Carpeta local',
    branch: null,
    stars: null,
    treeCount: files.length,
    treePreview: files.map((f) => f.path),
    contentHash,
  }
}

// ── Scoring y reporte ──────────────────────────────────────

function buildStructuralChecks(
  checks: ReturnType<typeof scanRepo>['checks'],
): StructuralCheck[] {
  const out: StructuralCheck[] = []
  out.push({
    id: 'manifest',
    label: 'Manifiesto de dependencias',
    status: checks.hasManifest ? 'pass' : 'warn',
    detail: checks.hasManifest
      ? `Encontrado: ${checks.manifestName}`
      : 'Sin package.json/go.mod/requirements.txt — no se pueden verificar dependencias',
    count: checks.hasManifest ? 1 : 0,
  })
  out.push({
    id: 'phantom-deps',
    label: 'Dependencias fantasma',
    status: checks.missingDeps.length > 0 ? 'fail' : 'pass',
    detail:
      checks.missingDeps.length > 0
        ? `Importadas pero no declaradas: ${checks.missingDeps.slice(0, 4).join(', ')}`
        : 'Todo lo importado está declarado',
    count: checks.missingDeps.length,
  })
  out.push({
    id: 'broken-imports',
    label: 'Imports rotos (módulos locales)',
    status: checks.brokenImports.length > 0 ? 'fail' : 'pass',
    detail:
      checks.brokenImports.length > 0
        ? `Archivos con imports que no resuelven: ${checks.brokenImports.slice(0, 3).join(', ')}`
        : 'Todos los imports locales resuelven a archivos existentes',
    count: checks.brokenImports.length,
  })
  out.push({
    id: 'secrets',
    label: 'Secretos en el código',
    status: checks.secretCount > 0 ? 'fail' : 'pass',
    detail:
      checks.secretCount > 0
        ? `${checks.secretCount} credencial(es) detectada(s) por patrón`
        : 'Sin patrones de credenciales',
    count: checks.secretCount,
  })
  out.push({
    id: 'env-committed',
    label: 'Archivos .env commiteados',
    status: checks.envFiles.length > 0 ? 'fail' : 'pass',
    detail:
      checks.envFiles.length > 0
        ? checks.envFiles.slice(0, 3).join(', ')
        : 'Ningún archivo de entorno en el repo',
    count: checks.envFiles.length,
  })
  out.push({
    id: 'unused-deps',
    label: 'Dependencias sin uso',
    status: checks.unusedDeps.length > 0 ? 'warn' : 'pass',
    detail:
      checks.unusedDeps.length > 0
        ? `Declaradas y nunca importadas: ${checks.unusedDeps.slice(0, 4).join(', ')}`
        : 'Sin dependencias muertas evidentes',
    count: checks.unusedDeps.length,
  })
  out.push({
    id: 'orphans',
    label: 'Archivos huérfanos',
    status: checks.orphanFiles.length > 0 ? 'warn' : 'pass',
    detail:
      checks.orphanFiles.length > 0
        ? `Nadie los importa: ${checks.orphanFiles.slice(0, 3).join(', ')}`
        : 'Todos los módulos están conectados',
    count: checks.orphanFiles.length,
  })
  out.push({
    id: 'test-integrity',
    label: 'Integridad de tests',
    status: checks.suspiciousTestFiles.length > 0 ? 'fail' : 'pass',
    detail:
      checks.suspiciousTestFiles.length > 0
        ? `Tests que no prueban nada o están saltados: ${checks.suspiciousTestFiles.slice(0, 3).join(', ')}`
        : 'Las suites de tests presentes pueden fallar de verdad',
    count: checks.suspiciousTestFiles.length,
  })
  return out
}

// ── Auditoría completa con progreso incremental ────────────

async function runAudit(
  body: Body,
  emit: Emit,
): Promise<{ id: string; report: RepoReport; cached: boolean }> {
  // ── 1. Ingesta ──────────────────────────────────────────
  let ingest: IngestResult
  const baseRef = body.source === 'github' ? body.base : undefined
  if (body.source === 'github') {
    ingest = await ingestGitHub(body.url, emit, { token: body.token, base: body.base })
  } else {
    emit({ type: 'progress', phase: 'estructura', pct: 8, message: 'Filtrando y leyendo archivos de la carpeta…' })
    ingest = ingestFolder(body)
  }
  const { files, repoName, branch, stars, treeCount, treePreview, contentHash, diff, baseHash } = ingest
  const cacheKey = `repo:${repoName}@${contentHash}${diff && baseHash ? `~diff:${baseHash}` : ''}`
  const changed = diff ? changedPaths(diff) : null

  // ── 2. Caché por contenido: mismo repo sin cambios → sin LLM ──
  try {
    const hit = await db.vibeCache.findUnique({ where: { key: cacheKey } })
    if (hit) {
      emit({ type: 'progress', phase: 'cache', pct: 80, message: 'Auditoría idéntica ya calculada — sirviendo desde caché' })
      const report = JSON.parse(hit.report) as RepoReport
      let id: string
      try {
        const saved = await db.vibeRepoCheck.create({
          data: {
            repoName: report.repoName,
            source: report.source,
            branch: report.branch,
            score: report.score,
            verdict: report.verdict,
            filesScanned: report.stats.filesScanned,
            filesAudited: report.stats.filesAudited,
            totalLines: report.stats.totalLines,
            isDiff: Boolean(report.diff),
            report: hit.report,
          },
        })
        id = saved.id
      } catch (dbError) {
        console.error('[vibecheck] repo DB save (cache hit) failed:', dbError)
        id = `ephemeral-${Date.now()}`
      }
      return { id, report, cached: true }
    }
  } catch (cacheError) {
    console.error('[vibecheck] cache lookup failed:', cacheError)
  }

  // ── 3. Escaneo determinista (árbol completo: contexto del grafo) ──
  const scan = scanRepo(files)
  emit({
    type: 'progress',
    phase: 'estructura',
    pct: 27,
    message: changed
      ? `Grafo listo (${scan.findings.length} hallazgos estructurales) — auditando solo los ${changed.size} archivos cambiados`
      : `Grafo de imports listo: ${scan.findings.length} hallazgos estructurales en ${treeCount} archivos`,
  })

  // ── 4. Auditoría IA por lotes (solo cambios en modo diff) ──
  const auditPool = changed ? files.filter((f) => changed.has(f.path)) : files
  const zai = await ZAI.create()
  const selection = selectAuditFiles(auditPool, scan.checks.manifestName)
  const aiRaw: RepoFinding[] = []
  const totalBatches = selection.batches.length
  for (let i = 0; i < totalBatches; i++) {
    const batch = selection.batches[i]
    if (!batch) continue
    emit({
      type: 'progress',
      phase: 'ia',
      pct: 30 + Math.round(40 * (i / Math.max(1, totalBatches))),
      message: `Auditando con IA: lote ${i + 1} de ${totalBatches} (${batch.length} archivos${changed ? ' cambiados' : ' críticos'})…`,
    })
    const raw = await auditBatch(zai, treePreview, batch)
    for (const f of raw) {
      aiRaw.push({ ...f, origin: 'ai' })
    }
  }

  // ── 5. Síntesis ─────────────────────────────────────────
  emit({ type: 'progress', phase: 'sintesis', pct: 78, message: 'Redactando el veredicto del repo…' })
  const reduced = await synthesizeReport(zai, {
    repoName,
    branch,
    stars,
    treePreview,
    scanFindings: scan.findings,
    aiFindings: aiRaw,
    stats: {
      filesScanned: treeCount,
      filesAudited: selection.auditedPaths.length,
      totalLines: scan.stats.totalLines,
      languages: scan.stats.languages,
      truncated: treeCount > MAX_FETCH_FILES,
    },
    externalUsed: scan.stats.externalUsed,
    diff: diff && baseRef ? { base: baseRef, changed: changed?.size ?? 0 } : undefined,
  })

  // ── 6. Merge de hallazgos + scoring (fuente única: repo-score) ──
  emit({ type: 'progress', phase: 'guardado', pct: 92, message: 'Calculando el Vibe Score…' })
  const { categories, score: mergedScore, excludedCount } = mergeAndScore(scan.findings, aiRaw, {
    onlyFiles: changed ?? undefined,
  })
  // la síntesis de IA redacta los summaries por categoría
  for (const key of Object.keys(categories) as CategoryKey[]) {
    categories[key].summary = reduced.categorySummaries[key]
  }

  const report: RepoReport = {
    score: mergedScore,
    verdict: verdictFromScore(mergedScore),
    repoName,
    source: body.source,
    branch,
    stars,
    summary: reduced.summary,
    architecture: reduced.architecture,
    stats: {
      filesScanned: treeCount,
      filesAudited: selection.auditedPaths.length,
      totalLines: scan.stats.totalLines,
      languages: scan.stats.languages,
      truncated: treeCount > MAX_FETCH_FILES,
    },
    diff:
      diff && baseRef
        ? {
            base: baseRef,
            filesAdded: diff.added.length,
            filesModified: diff.modified.length,
            filesDeleted: diff.deleted.length,
            excludedFindings: excludedCount,
          }
        : undefined,
    vibeSignals: reduced.vibeSignals,
    topRisks: reduced.topRisks,
    structural: buildStructuralChecks(scan.checks),
    categories,
    scoreExplanation: explainScore(categories, mergedScore),
  }

  // ── 7. Persistir historial + caché (nunca los contenidos) ──
  let id: string
  try {
    const saved = await db.vibeRepoCheck.create({
      data: {
        repoName,
        source: body.source,
        branch,
        score: report.score,
        verdict: report.verdict,
        filesScanned: report.stats.filesScanned,
        filesAudited: report.stats.filesAudited,
        totalLines: report.stats.totalLines,
        isDiff: Boolean(report.diff),
        report: JSON.stringify(report),
      },
    })
    id = saved.id
  } catch (dbError) {
    console.error('[vibecheck] repo DB save failed:', dbError)
    id = `ephemeral-${Date.now()}`
  }

  try {
    await db.vibeCache.create({
      data: { key: cacheKey, score: report.score, verdict: report.verdict, report: JSON.stringify(report) },
    })
  } catch (cacheError) {
    console.error('[vibecheck] cache save failed:', cacheError)
  }

  return { id, report, cached: false }
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = bodySchema.parse(await req.json())
  } catch (err) {
    const msg = err instanceof z.ZodError ? 'Petición inválida (revisa límites de tamaño/archivos).' : 'Petición inválida.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  // Rate limit antes de cualquier trabajo pesado: la cuota quemada es de LLM
  const rl = rateLimit(`repo-audit:${clientKeyFrom(req)}`, REPO_AUDITS_PER_HOUR, HOUR_MS)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Límite de ${REPO_AUDITS_PER_HOUR} auditorías de repo por hora alcanzado. Reintenta en ~${Math.ceil(rl.retryAfterSec / 60)} minutos.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const wantsStream = req.headers.get('accept')?.includes('text/event-stream') ?? false

  if (!wantsStream) {
    try {
      const result = await runAudit(body, () => {})
      return NextResponse.json(result)
    } catch (error) {
      console.error('[vibecheck] analyze-repo failed:', error)
      const message = error instanceof Error ? error.message : 'Error desconocido'
      return NextResponse.json({ error: `No se pudo auditar el repo: ${message}` }, { status: 500 })
    }
  }

  // Modo streaming: NDJSON con eventos de progreso reales
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          /* el cliente cerró la conexión */
        }
      }
      try {
        const result = await runAudit(body, emit)
        emit({ type: 'done', id: result.id, report: result.report, cached: result.cached })
      } catch (error) {
        console.error('[vibecheck] analyze-repo (stream) failed:', error)
        const message = error instanceof Error ? error.message : 'Error desconocido'
        emit({ type: 'error', error: `No se pudo auditar el repo: ${message}` })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
