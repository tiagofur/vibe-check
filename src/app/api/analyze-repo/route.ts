import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
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
import { auditBatch, selectAuditFiles, synthesizeReport } from '@/lib/repo-llm'
import {
  CATEGORY_META,
  type CategoryKey,
  scoreFromFindings,
  verdictFromScore,
} from '@/lib/vibe-types'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_SCAN_FILES = 220
const MAX_FETCH_FILES = 120
const MAX_FILE_BYTES = 40 * 1024
const MAX_UPLOAD_FILES = 300
const MAX_UPLOAD_TOTAL = 900_000

const bodySchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'),
    url: z.string().min(10).max(300),
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

const CATEGORY_KEYS: CategoryKey[] = ['security', 'hallucination', 'bugs', 'overengineering']
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

// ── GitHub (tarball vía codeload: sin límites de la API) ───

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

async function ingestGitHub(url: string): Promise<{
  files: RepoFile[]
  repoName: string
  branch: string
  stars: number | null
  treeCount: number
  treePreview: string[]
}> {
  const parsed = parseGitHubUrl(url)
  if (!parsed || !parsed.owner || !parsed.repo) {
    throw new Error('URL de GitHub inválida. Formato esperado: https://github.com/owner/repo')
  }
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdtemp, writeFile, readdir, readFile, stat, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const pathMod = await import('node:path')
  const execFileAsync = promisify(execFile)

  // Descarga el tarball (probamos main/master si no viene rama explícita)
  const branches = parsed.branch ? [parsed.branch] : ['main', 'master']
  let tarPath: string | null = null
  let usedBranch = branches[0] ?? 'main'
  for (const br of branches) {
    const res = await fetch(
      `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/refs/heads/${encodeURIComponent(br)}`,
      {
        headers: { 'User-Agent': 'vibecheck-opensource-auditor' },
        signal: AbortSignal.timeout(45000),
      },
    )
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 40 * 1024 * 1024) {
        throw new Error('El repo es demasiado grande para la auditoría gratuita (>40 MB comprimido).')
      }
      const dir = await mkdtemp(pathMod.join(tmpdir(), 'vibecheck-'))
      tarPath = pathMod.join(dir, 'repo.tar.gz')
      await writeFile(tarPath, buf)
      usedBranch = br
      break
    }
    if (res.status === 404) continue
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub está limitando temporalmente las descargas. Inténtalo en unos minutos.')
    }
    throw new Error(`GitHub respondió ${res.status} al descargar el repositorio.`)
  }
  if (!tarPath) {
    throw new Error(
      'No se encontró el repo o la rama (¿es privado?). Los repos privados aún no están soportados.',
    )
  }

  const workDir = pathMod.dirname(tarPath)
  try {
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
        const content = await readFile(f.abs, 'utf8')
        files.push({ path: f.path, content })
      } catch {
        /* archivo ilegible: se ignora */
      }
    }

    if (files.length === 0) {
      throw new Error('El repo no contiene archivos de código auditable (¿solo binarios/documentación?).')
    }

    return {
      files,
      repoName: `${parsed.owner}/${parsed.repo}`,
      branch: usedBranch,
      stars: null, // el tarball anónimo no expone metadatos; sin estrellas por ahora
      treeCount,
      treePreview,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

// ── Scoring y reporte ──────────────────────────────────────

function dedupe(findings: RepoFinding[]): RepoFinding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = `${f.file}|${f.title.toLowerCase().replace(/\s+/g, ' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

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
  return out
}

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch (err) {
    const msg = err instanceof z.ZodError ? 'Petición inválida (revisa límites de tamaño/archivos).' : 'Petición inválida.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  try {
    // ── 1. Ingesta ──────────────────────────────────────────
    let files: RepoFile[]
    let repoName: string
    let branch: string | null = null
    let stars: number | null = null
    let treeCount: number
    let treePreview: string[]

    if (body.source === 'github') {
      const ingested = await ingestGitHub(body.url)
      files = ingested.files
      repoName = ingested.repoName
      branch = ingested.branch
      stars = ingested.stars
      treeCount = ingested.treeCount
      treePreview = ingested.treePreview
      if (files.length === 0) {
        throw new Error('No se pudo descargar ningún archivo auditable del repo (¿vacío o solo binarios?).')
      }
    } else {
      files = body.files
        .filter((f) => isScannablePath(f.path, f.content.length))
        .map((f) => ({ path: f.path.replace(/^\.\//, ''), content: f.content }))
        .slice(0, MAX_SCAN_FILES)
      repoName = body.title?.trim() || 'Carpeta local'
      treeCount = files.length
      treePreview = files.map((f) => f.path)
      if (files.length === 0) {
        throw new Error('Ningún archivo de la carpeta es auditable (¿solo binarios o node_modules?).')
      }
    }

    // ── 2. Escaneo determinista ─────────────────────────────
    const scan = scanRepo(files)

    // ── 3. Auditoría IA por lotes ───────────────────────────
    const zai = await ZAI.create()
    const selection = selectAuditFiles(files, scan.checks.manifestName)
    const aiRaw: RepoFinding[] = []
    for (const batch of selection.batches) {
      const raw = await auditBatch(zai, treePreview, batch)
      for (const f of raw) {
        aiRaw.push({ ...f, origin: 'ai' })
      }
    }

    // ── 4. Síntesis ─────────────────────────────────────────
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
    })

    // ── 5. Merge de hallazgos + scoring ─────────────────────
    const allFindings = dedupe([...scan.findings, ...aiRaw])
    const categories = {} as RepoReport['categories']
    let globalScore = 0
    for (const key of CATEGORY_KEYS) {
      const merged = allFindings
        .filter((f) => f.category === key)
        .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
      const score = scoreFromFindings(merged)
      categories[key] = { score, summary: reduced.categorySummaries[key], findings: merged }
      globalScore += score * CATEGORY_META[key].weight
    }

    let score = Math.round(globalScore)
    const hasCritical = (k: CategoryKey) => categories[k].findings.some((f) => f.severity === 'critical')
    if (hasCritical('security') || hasCritical('hallucination')) score = Math.min(score, 35)
    else if (hasCritical('bugs') || hasCritical('overengineering')) score = Math.min(score, 55)

    const report: RepoReport = {
      score,
      verdict: verdictFromScore(score),
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
      vibeSignals: reduced.vibeSignals,
      topRisks: reduced.topRisks,
      structural: buildStructuralChecks(scan.checks),
      categories,
    }

    // ── 6. Persistir (solo el reporte, nunca los contenidos) ──
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
          report: JSON.stringify(report),
        },
      })
      id = saved.id
    } catch (dbError) {
      console.error('[vibecheck] repo DB save failed:', dbError)
      id = `ephemeral-${Date.now()}`
    }

    return NextResponse.json({ id, report })
  } catch (error) {
    console.error('[vibecheck] analyze-repo failed:', error)
    const message = error instanceof Error ? error.message : 'Error desconocido'
    return NextResponse.json({ error: `No se pudo auditar el repo: ${message}` }, { status: 500 })
  }
}
