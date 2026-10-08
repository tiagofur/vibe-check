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
  scanRepo,
} from '@/lib/repo-scan'
import { changedPaths, diffTrees, type TreeDiff } from '@/lib/repo-diff'
import { explainScore, mergeAndScore, verdictFromScore } from '@/lib/repo-score'
import { auditBatch, selectAuditFiles, synthesizeReport, type ReduceResult } from '@/lib/repo-llm'
import { buildDeterministicNarrative } from '@/lib/deterministic-report'
import { FOLDER_CAPS, isStructuralFile } from '@/lib/folder-pick'
import { MAX_DECOMPRESSED_BYTES, readTarTree, type TreeReadResult } from '@/lib/tar-gz'
import type { CategoryKey } from '@/lib/vibe-types'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_SCAN_FILES = 600
const MAX_FETCH_FILES = 120

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
          // el cliente recorta el contenido a FOLDER_CAPS.readCap (64KB); holgura multibyte
          content: z.string().max(128 * 1024),
        }),
      )
      .min(1)
      .max(FOLDER_CAPS.maxFiles)
      .superRefine((files, ctx) => {
        const total = files.reduce((sum, f) => sum + f.content.length, 0)
        if (total > FOLDER_CAPS.maxTotalBytes) {
          ctx.addIssue({ code: 'custom', message: 'La carpeta excede el presupuesto total de contenido' })
        }
      }),
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

interface IngestResult {
  files: RepoFile[]
  repoName: string
  branch: string | null
  stars: number | null
  treeCount: number
  treePreview: string[]
  /** Rutas de todo el árbol escaneable (GitHub): resuelve imports fuera del top-N */
  allPaths?: string[]
  /** sha256 del contenido descargado: clave de caché */
  contentHash: string
  /** El árbol excedió el cap de lectura: se auditó el top-N por riesgo */
  truncated: boolean
  /** Presente en modo diff: cambios entre el ref base y el auditado */
  diff?: TreeDiff
  /** sha256 del árbol base (parte de la clave de caché en modo diff) */
  baseHash?: string
}

/** En modo diff ambos árboles se leen completos (hasta este cap) para comparar contenido */
const MAX_DIFF_FILES = 4000

/** Rama default de un repo vía API (1 llamada, solo si main/master no existen) */
async function fetchDefaultBranch(owner: string, repo: string, token: string | undefined): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'User-Agent': 'vibecheck-opensource-auditor',
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { default_branch?: string }
    return json.default_branch ?? null
  } catch {
    return null
  }
}

/** Un ref puede ser tag, rama o sha: probamos las tres formas */
const refCandidates = (ref: string): string[] => [`refs/tags/${ref}`, `refs/heads/${ref}`, ref]

/**
 * Descarga el tarball del ref EN STREAMING (sin límite de tamaño: el
 * stream se consume entrada a entrada) y lee el árbol top-N por riesgo.
 */
async function downloadTree(
  owner: string,
  repo: string,
  candidates: string[],
  token: string | undefined,
  label: string,
  opts: { maxFiles: number },
): Promise<{ ref: string; contentHash: string; tree: TreeReadResult }> {
  const headers: Record<string, string> = { 'User-Agent': 'vibecheck-opensource-auditor' }
  if (token) headers.Authorization = `Bearer ${token}`
  const base = token
    ? `https://api.github.com/repos/${owner}/${repo}/tarball` // soporta repos privados
    : `https://codeload.github.com/${owner}/${repo}/tar.gz`

  for (const candidate of candidates) {
    const res = await fetch(`${base}/${candidate}`, {
      headers,
      signal: AbortSignal.timeout(120_000),
    })
    if (res.ok && res.body) {
      const hash = createHash('sha256')
      const hashed = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            hash.update(chunk)
            controller.enqueue(chunk)
          },
        }),
      )
      const tree = await readTarTree(hashed, {
        maxFiles: opts.maxFiles,
        maxDecompressedBytes: opts.maxFiles > 1000 ? MAX_DECOMPRESSED_BYTES : MAX_DECOMPRESSED_BYTES,
      })
      return {
        ref: candidate.replace(/^refs\/(tags|heads)\//, ''),
        contentHash: hash.digest('hex'),
        tree,
      }
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
  let head: Awaited<ReturnType<typeof downloadTree>>
  try {
    head = await downloadTree(parsed.owner, parsed.repo, headCandidates, token, 'el repo o la rama', {
      maxFiles: opts.base ? MAX_DIFF_FILES : MAX_FETCH_FILES,
    })
  } catch (err) {
    // sin rama explícita, la default puede no ser main/master (ej. next.js usa canary)
    if (parsed.branch) throw err
    const defaultBranch = await fetchDefaultBranch(parsed.owner, parsed.repo, token)
    if (!defaultBranch) throw err
    emit({
      type: 'progress',
      phase: 'descarga',
      pct: 8,
      message: `La rama default es "${defaultBranch}" — descargando esa…`,
    })
    head = await downloadTree(parsed.owner, parsed.repo, refCandidates(defaultBranch), token, 'el repo o la rama', {
      maxFiles: opts.base ? MAX_DIFF_FILES : MAX_FETCH_FILES,
    })
  }
  const headTree = head.tree

  emit({
    type: 'progress',
    phase: 'descarga',
    pct: 14,
    message: headTree.truncated
      ? `Árbol leído en streaming: ${headTree.treeCount} archivos escaneables — contenido del top ${headTree.files.length} por riesgo`
      : `Árbol completo leído en streaming: ${headTree.treeCount} archivos escaneables`,
  })

  if (headTree.files.length === 0) {
    throw new Error('El repo no contiene archivos de código auditable (¿solo binarios/documentación?).')
  }

  let diff: TreeDiff | undefined
  let baseHash: string | undefined

  // ── Modo diff: descargar el ref base y comparar árboles ──
  if (opts.base) {
    const base = await downloadTree(parsed.owner, parsed.repo, refCandidates(opts.base), token, `el ref base "${opts.base}"`, {
      maxFiles: MAX_DIFF_FILES,
    })
    baseHash = base.contentHash
    emit({ type: 'progress', phase: 'descarga', pct: 20, message: `Descargando el ref base "${opts.base}" para el diff…` })
    diff = diffTrees(
      new Map(base.tree.files.map((f) => [f.path, f.content])),
      new Map(headTree.files.map((f) => [f.path, f.content])),
    )
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
    allPaths: headTree.allPaths,
    contentHash: head.contentHash,
    truncated: headTree.truncated,
    diff,
    baseHash,
  }
}

function ingestFolder(body: Extract<Body, { source: 'files' }>): IngestResult {
  const eligible = body.files
    .filter((f) => isScannablePath(f.path, f.content.length))
    .map((f) => ({ path: f.path.replace(/^\.\//, ''), content: f.content }))
  // manifiesto y tsconfig viajan siempre: sin ellos el grafo inventa fantasmas
  const structural = eligible.filter((f) => isStructuralFile(f.path))
  const rest = eligible.filter((f) => !isStructuralFile(f.path))
  const contentSlots = Math.max(0, MAX_SCAN_FILES - structural.length)
  // lo que no cabe en el presupuesto de contenido se conserva solo como ruta,
  // para que los imports del sample resuelvan contra el árbol completo
  const overflowPaths = rest.slice(contentSlots).map((f) => ({ path: f.path, content: '' }))
  const files = [...structural, ...rest.slice(0, contentSlots), ...overflowPaths]
  if (structural.length + rest.length === 0) {
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
    treeCount: eligible.length,
    treePreview: files.map((f) => f.path),
    contentHash,
    truncated: overflowPaths.length > 0,
  }
}

// ── Scoring y reporte ──────────────────────────────────────

function buildStructuralChecks(
  checks: ReturnType<typeof scanRepo>['checks'],
  partial = false,
): StructuralCheck[] {
  const out: StructuralCheck[] = []
  // en muestra parcial, deps sin uso y huérfanos son conteos observados, no afirmaciones
  const sampleNote = partial ? ' (muestra parcial del árbol: puede haber más)' : ''
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
        ? `Declaradas y nunca importadas${sampleNote}: ${checks.unusedDeps.slice(0, 4).join(', ')}`
        : 'Sin dependencias muertas evidentes',
    count: checks.unusedDeps.length,
  })
  out.push({
    id: 'orphans',
    label: 'Archivos huérfanos',
    status: checks.orphanFiles.length > 0 ? 'warn' : 'pass',
    detail:
      checks.orphanFiles.length > 0
        ? `Nadie los importa${sampleNote}: ${checks.orphanFiles.slice(0, 3).join(', ')}`
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
  const { files, repoName, branch, stars, treeCount, treePreview, allPaths, contentHash, truncated, diff, baseHash } = ingest
  // v2: los reportes pre-alias (falsos positivos masivos con @/*) no se sirven desde caché
  const cacheKey = `repo:v2:${repoName}@${contentHash}${diff && baseHash ? `~diff:${baseHash}` : ''}`
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
  const scan = scanRepo(files, { allPaths, partialTree: truncated })
  emit({
    type: 'progress',
    phase: 'estructura',
    pct: 27,
    message: changed
      ? `Grafo listo (${scan.findings.length} hallazgos estructurales) — auditando solo los ${changed.size} archivos cambiados`
      : `Grafo de imports listo: ${scan.findings.length} hallazgos estructurales en ${treeCount} archivos`,
  })

  // ── 4. Auditoría IA por lotes — con fallback determinista sin credenciales ──
  // los archivos solo-ruta (sin contenido) no van al LLM: solo nutren el grafo
  const auditPool = (changed ? files.filter((f) => changed.has(f.path)) : files).filter(
    (f) => f.content.length > 0,
  )
  const aiRaw: RepoFinding[] = []
  let engine: 'ia' | 'determinista' = 'ia'
  let auditedPaths: string[] = []
  let zai: Awaited<ReturnType<typeof ZAI.create>> | null = null
  try {
    zai = await ZAI.create()
  } catch (aiError) {
    engine = 'determinista'
    console.error('[vibecheck] IA no disponible — reporte solo con el motor determinista:', aiError)
    emit({
      type: 'progress',
      phase: 'ia',
      pct: 45,
      message: 'Sin credenciales de IA — redactando con el motor determinista (reproducible)…',
    })
  }

  if (zai) {
    const selection = selectAuditFiles(auditPool, scan.checks.manifestName)
    auditedPaths = selection.auditedPaths
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
  }

  // ── 5. Síntesis (IA; la determinista se redacta tras el scoring) ──
  emit({
    type: 'progress',
    phase: 'sintesis',
    pct: 78,
    message: engine === 'ia' ? 'Redactando el veredicto del repo…' : 'Veredicto determinista del repo…',
  })
  let reduced: ReduceResult | null = null
  if (zai) {
    reduced = await synthesizeReport(zai, {
      repoName,
      branch,
      stars,
      treePreview,
      scanFindings: scan.findings,
      aiFindings: aiRaw,
      stats: {
        filesScanned: treeCount,
        filesAudited: auditedPaths.length,
        totalLines: scan.stats.totalLines,
        languages: scan.stats.languages,
        truncated,
      },
      externalUsed: scan.stats.externalUsed,
      diff: diff && baseRef ? { base: baseRef, changed: changed?.size ?? 0 } : undefined,
    })
  }

  // ── 6. Merge de hallazgos + scoring (fuente única: repo-score) ──
  emit({ type: 'progress', phase: 'guardado', pct: 92, message: 'Calculando el Vibe Score…' })
  const { categories, score: mergedScore, excludedCount } = mergeAndScore(scan.findings, aiRaw, {
    onlyFiles: changed ?? undefined,
  })
  const verdict = verdictFromScore(mergedScore)
  const structuralChecks = buildStructuralChecks(scan.checks, truncated)

  // sin IA, la narrativa se redacta con hechos del escaneo (verificables)
  if (!reduced) {
    reduced = buildDeterministicNarrative({
      repoName,
      branch,
      verdict,
      stats: {
        filesScanned: treeCount,
        filesAudited: auditedPaths.length,
        totalLines: scan.stats.totalLines,
        languages: scan.stats.languages,
      },
      structural: structuralChecks,
      categories,
      manifestName: scan.checks.manifestName,
    })
  }

  // la síntesis (IA o determinista) redacta los summaries por categoría
  for (const key of Object.keys(categories) as CategoryKey[]) {
    categories[key].summary = reduced.categorySummaries[key]
  }

  const report: RepoReport = {
    score: mergedScore,
    verdict,
    repoName,
    source: body.source,
    branch,
    stars,
    summary: reduced.summary,
    architecture: reduced.architecture,
    stats: {
      filesScanned: treeCount,
      filesAudited: auditedPaths.length,
      totalLines: scan.stats.totalLines,
      languages: scan.stats.languages,
      truncated,
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
    structural: structuralChecks,
    categories,
    scoreExplanation: explainScore(categories, mergedScore),
    engine,
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
