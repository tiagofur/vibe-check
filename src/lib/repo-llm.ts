// ─────────────────────────────────────────────────────────────
// VibeCheck · Orquestación de LLM para auditoría de repos
// Estrategia: triage determinista → auditoría por lotes → síntesis.
// ─────────────────────────────────────────────────────────────

import type { ChatMessage, LlmClient } from './llm'
import type { RepoFile, RepoFinding } from './repo-types'
import type { CategoryKey, Severity } from './vibe-types'
import { riskScore } from './repo-scan'

const MAX_BATCH_CHARS = 13000
const MAX_FILES_PER_BATCH = 12
const MAX_BATCHES = 3
const MAX_AUDIT_FILES = 32

export interface AuditSelection {
  batches: RepoFile[][]
  auditedPaths: string[]
  truncated: boolean
}

/** Selecciona los archivos de mayor riesgo y los parte en lotes para el LLM */
export function selectAuditFiles(
  files: RepoFile[],
  manifestPath: string | null,
): AuditSelection {
  const ranked = [...files].sort((a, b) => riskScore(b.path) - riskScore(a.path))

  // Garantiza hasta 3 archivos de test (caza de tests falsos)
  const testFiles = ranked.filter((f) => /test|spec/i.test(f.path)).slice(0, 3)
  const pool: RepoFile[] = []
  const seen = new Set<string>()
  let overflow = 0 // elegibles que quedan fuera por el techo MAX_AUDIT_FILES
  const push = (f: RepoFile) => {
    if (seen.has(f.path)) return
    if (pool.length >= MAX_AUDIT_FILES) {
      overflow++
      return
    }
    seen.add(f.path)
    pool.push(f)
  }
  if (manifestPath) {
    const mf = files.find((f) => f.path === manifestPath)
    if (mf) push(mf)
  }
  for (const f of ranked) push(f)
  for (const f of testFiles) push(f)

  // Parte en lotes por presupuesto de caracteres
  const batches: RepoFile[][] = []
  let current: RepoFile[] = []
  let chars = 0
  for (const f of pool) {
    const size = f.content.length + f.path.length + 24
    if (size > MAX_BATCH_CHARS) continue // demasiado grande para auditoría profunda
    if (current.length >= MAX_FILES_PER_BATCH || chars + size > MAX_BATCH_CHARS) {
      if (current.length > 0) batches.push(current)
      if (batches.length >= MAX_BATCHES) break
      current = []
      chars = 0
    }
    current.push(f)
    chars += size
  }
  if (current.length > 0 && batches.length < MAX_BATCHES) batches.push(current)

  return {
    batches,
    auditedPaths: batches.flat().map((f) => f.path),
    truncated: overflow > 0 || pool.length > batches.reduce((n, b) => n + b.length, 0),
  }
}

const AUDIT_SYSTEM = `Eres VibeCheck, un auditor de código ADVERSARIAL especializado en repositorios generados o inflados con IA ("vibe coding"). Recibes un lote de archivos de un repo (con ruta completa) y debes cazar:

1. SECURITY: secretos hardcodeados, inyección SQL/XSS/comandos, endpoints sin auth, validación ausente, CORS peligroso, contraseñas comparadas inseguras.
2. HALLUCINATION: APIs/métodos/propiedades que NO existen en el lenguaje o librería usada, llamadas a funciones que no están definidas en NINGÚN archivo del lote ni vienen de imports, firmas incorrectas, opciones de configuración inventadas. Solo marca si estás SEGURO.
3. BUGS: errores lógicos, null/undefined sin manejar, NaN, off-by-one, promesas sin await, race conditions, operadores equivocados.
4. OVERENGINEERING: abstracciones injustificadas, capas sin sentido, código muerto evidente, duplicación entre archivos del lote.
5. TESTS FALSOS (categoría "bugs"): tests que no pueden fallar (assert sobre mocks, sin assertions, tautológicos).

REGLAS:
- Usa EXACTAMENTE las rutas de archivo que te doy (campo "file").
- "lines" son números de línea reales del archivo (1-indexed).
- Los archivos .env.example/.env.sample/.env.template existen PARA commitearse con valores de ejemplo: NO son filtraciones, no generes hallazgos de seguridad por ellos.
- Verifica el CÓDIGO ejecutable, no los comentarios: suelen describir fixes históricos o riesgos ya resueltos (típico en migraciones). Un comentario que advierte de un peligro NO es en sí un bug.
- Un monorepo puede declararse en package.json ("workspaces") o en pnpm-workspace.yaml/turbo.json/lerna.json: no marques "faltan workspaces" si otra de estas configs lo declara.
- Prioriza IMPACTO: máximo 4 hallazgos por archivo; ignora estilo y nits.
- explanation y fix en ESPAÑOL, máximo 2 frases cada uno, sin markdown.
- Si un archivo está limpio, NO generes hallazgo para él.

Responde ÚNICAMENTE con JSON válido:
{"findings":[{"file":"ruta/exacta","lines":[1],"severity":"critical|high|medium|low|info","category":"security|hallucination|bugs|overengineering","title":"corto","explanation":"...","fix":"..."}]}`

export interface RawAIFinding {
  file: string
  lines: number[]
  severity: Severity
  category: CategoryKey
  title: string
  explanation: string
  fix: string
}

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('respuesta sin JSON')
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    const salvaged = salvagePartialFindings(raw)
    if (salvaged) {
      console.warn('[vibecheck] JSON truncado del LLM: se recuperaron hallazgos parciales')
      return salvaged
    }
    throw new Error('JSON malformado en la respuesta')
  }
}

/** Recupera hallazgos de una respuesta JSON cortada a mitad de camino */
function salvagePartialFindings(text: string): Record<string, unknown> | null {
  const idx = text.indexOf('"findings"')
  if (idx === -1) return null
  const arrStart = text.indexOf('[', idx)
  if (arrStart === -1) return null
  let cut = text.lastIndexOf('}')
  let attempts = 0
  while (cut > arrStart && attempts < 80) {
    try {
      const candidate = JSON.parse(`${text.slice(0, cut + 1)}]}`) as Record<string, unknown>
      if (Array.isArray(candidate.findings)) return candidate
    } catch {
      /* seguimos cortando hacia atrás */
    }
    cut = text.lastIndexOf('}', cut - 1)
    attempts++
  }
  return null
}

async function chatJSON(llm: LlmClient, messages: ChatMessage[]): Promise<Record<string, unknown>> {
  const content = await llm.complete(messages)
  return extractJson(content)
}

export async function auditBatch(
  llm: LlmClient,
  treePreview: string[],
  batch: RepoFile[],
): Promise<RawAIFinding[]> {
  const filesText = batch
    .map((f) => `===== FILE: ${f.path} =====\n${f.content}`)
    .join('\n\n')
  const user = `Árbol del repo (contexto, recortado):\n${treePreview.slice(0, 80).join('\n')}\n\nArchivos a auditar en este lote:\n\n${filesText}`
  // sin try/catch a propósito: el caller informa el fallo (lote visible en el progreso)
  const parsed = await chatJSON(llm, [
    { role: 'assistant', content: AUDIT_SYSTEM },
    { role: 'user', content: user },
  ])
  const raw = Array.isArray(parsed.findings) ? parsed.findings : []
  const validPaths = new Set(batch.map((f) => f.path))
  const out: RawAIFinding[] = []
  for (const item of raw.slice(0, 20)) {
    if (typeof item !== 'object' || item === null) continue
    const f = item as Record<string, unknown>
    const file = typeof f.file === 'string' ? f.file : ''
    const severity = ['critical', 'high', 'medium', 'low', 'info'].includes(String(f.severity))
      ? (f.severity as Severity)
      : 'medium'
    const category = (['security', 'hallucination', 'bugs', 'overengineering'] as const).includes(
      f.category as CategoryKey,
    )
      ? (f.category as CategoryKey)
      : 'bugs'
    if (!validPaths.has(file)) continue
    out.push({
      file,
      lines: Array.isArray(f.lines)
        ? f.lines.filter((n): n is number => typeof n === 'number').slice(0, 8)
        : [],
      severity,
      category,
      title: String(f.title ?? 'Hallazgo').slice(0, 120),
      explanation: String(f.explanation ?? '').slice(0, 400),
      fix: String(f.fix ?? '').slice(0, 400),
    })
  }
  return out
}

export interface ReduceResult {
  summary: string
  architecture: string
  vibeSignals: { title: string; detail: string }[]
  topRisks: { title: string; detail: string; severity: Severity }[]
  categorySummaries: Record<CategoryKey, string>
}

const REDUCE_SYSTEM = `Eres VibeCheck, el auditor jefe que redacta el veredicto final de un repositorio posiblemente generado con IA. Recibes: metadatos del repo, árbol de archivos, hallazgos del escaneo determinista (origin=scan, 100% fiables) y hallazgos de auditoría IA (origin=ai).

Tu trabajo:
1. "summary": 2-3 frases sobre qué es este repo y su estado general (español).
2. "architecture": 2-3 frases describiendo la arquitectura/estructura real que deduces del árbol (stack, patrones, organización).
3. "vibeSignals": 2-5 señales de que el código fue generado por IA sin revisión (o de que es humano), con evidencia concreta. Array vacío si no hay señal.
4. "topRisks": los 3-5 riesgos MÁS graves combinando ambas fuentes (los scan son verificables: priorízalos).
5. "categorySummaries": 1-2 frases por categoría en español.

JSON EXCLUSIVO:
{"summary":"...","architecture":"...","vibeSignals":[{"title":"...","detail":"..."}],"topRisks":[{"title":"...","detail":"...","severity":"critical|high|medium|low|info"}],"categorySummaries":{"security":"...","hallucination":"...","bugs":"...","overengineering":"..."}}`

export async function synthesizeReport(
  llm: LlmClient,
  ctx: {
    repoName: string
    branch: string | null
    stars: number | null
    treePreview: string[]
    scanFindings: RepoFinding[]
    aiFindings: RepoFinding[]
    stats: { filesScanned: number; filesAudited: number; totalLines: number; languages: string[]; truncated: boolean }
    externalUsed: string[]
    /** Presente en modo diff: solo se puntúan los archivos cambiados */
    diff?: { base: string; changed: number }
  },
): Promise<ReduceResult> {
  const compact = (fs: RepoFinding[]) =>
    fs.slice(0, 40).map((f) => ({
      file: f.file,
      lines: f.lines.slice(0, 4),
      severity: f.severity,
      title: f.title,
      explanation: f.explanation.slice(0, 220),
      origin: f.origin,
    }))

  const user = `Repo: ${ctx.repoName}${ctx.branch ? ` (rama ${ctx.branch})` : ''}${ctx.stars !== null ? ` · ${ctx.stars} stars` : ''}
Stats: ${ctx.stats.filesScanned} archivos escaneados, ${ctx.stats.filesAudited} auditados a fondo, ${ctx.stats.totalLines} líneas, lenguajes: ${ctx.stats.languages.join(', ') || 'n/d'}${ctx.stats.truncated ? ' (árbol truncado)' : ''}
${ctx.diff ? `MODO DIFF: esta auditoría cubre SOLO los ${ctx.diff.changed} archivos cambiados desde "${ctx.diff.base}". Enfoca summary, riesgos y señales en los cambios.\n` : ''}Paquetes externos usados: ${ctx.externalUsed.slice(0, 40).join(', ') || 'ninguno'}

Árbol (recortado):
${ctx.treePreview.slice(0, 100).join('\n')}

Hallazgos escaneo determinista:
${JSON.stringify(compact(ctx.scanFindings))}

Hallazgos auditoría IA:
${JSON.stringify(compact(ctx.aiFindings))}`

  try {
    const parsed = await chatJSON(llm, [
      { role: 'assistant', content: REDUCE_SYSTEM },
      { role: 'user', content: user },
    ])
    const str = (v: unknown, fb: string) => (typeof v === 'string' && v.trim() ? v.trim() : fb)
    const signals = Array.isArray(parsed.vibeSignals) ? parsed.vibeSignals : []
    const risks = Array.isArray(parsed.topRisks) ? parsed.topRisks : []
    const cs = (parsed.categorySummaries ?? {}) as Record<string, unknown>
    return {
      summary: str(parsed.summary, 'Repositorio analizado.'),
      architecture: str(parsed.architecture, 'No se pudo inferir la arquitectura.'),
      vibeSignals: signals
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .slice(0, 6)
        .map((s) => ({ title: str(s.title, 'Señal').slice(0, 120), detail: str(s.detail, '').slice(0, 400) })),
      topRisks: risks
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .slice(0, 6)
        .map((r) => ({
          title: str(r.title, 'Riesgo').slice(0, 140),
          detail: str(r.detail, '').slice(0, 400),
          severity: (['critical', 'high', 'medium', 'low', 'info'].includes(String(r.severity))
            ? r.severity
            : 'medium') as Severity,
        })),
      categorySummaries: {
        security: str(cs.security, 'Sin observaciones destacadas.'),
        hallucination: str(cs.hallucination, 'Sin observaciones destacadas.'),
        bugs: str(cs.bugs, 'Sin observaciones destacadas.'),
        overengineering: str(cs.overengineering, 'Sin observaciones destacadas.'),
      },
    }
  } catch (e) {
    console.error('[vibecheck] reduce failed:', e)
    return {
      summary: 'Análisis completado; la síntesis final de IA no estuvo disponible.',
      architecture: 'No se pudo inferir la arquitectura en esta pasada.',
      vibeSignals: [],
      topRisks: [],
      categorySummaries: {
        security: 'Revisa los hallazgos detallados.',
        hallucination: 'Revisa los hallazgos detallados.',
        bugs: 'Revisa los hallazgos detallados.',
        overengineering: 'Revisa los hallazgos detallados.',
      },
    }
  }
}
