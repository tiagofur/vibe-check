import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { clientKeyFrom, rateLimit } from '@/lib/rate-limit'
import { getLLM, type LlmClient } from '@/lib/llm'
import {
  type Finding,
  type Severity,
  type VibeReport,
  type CategoryKey,
  CATEGORY_META,
  scoreFromFindings,
  verdictFromScore,
  MAX_CODE_LENGTH,
} from '@/lib/vibe-types'

export const runtime = 'nodejs'
export const maxDuration = 300

const bodySchema = z.object({
  code: z.string().min(10, 'El código es demasiado corto').max(60_000),
  language: z.string().min(1).max(40).default('auto'),
  title: z.string().max(120).optional(),
})

const VALID_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
const CATEGORY_KEYS: CategoryKey[] = ['security', 'hallucination', 'bugs', 'overengineering']

const SYSTEM_PROMPT = `Eres VibeCheck, un auditor de código experto especializado en la era del "vibe coding": código que fue generado por IA (ChatGPT, Copilot, Cursor...) y pegado a producción sin revisión profunda. Tu misión es detectar con precisión quirúrgica problemas en 4 categorías:

1. SECURITY (seguridad): secretos hardcodeados (API keys, passwords, tokens privados), inyección SQL/XSS/comandos, falta de validación de entrada, endpoints sin autenticación, datos sensibles en logs, CORS peligroso, comparaciones de contraseñas inseguras.

2. HALLUCINATION (alucinaciones): imports de paquetes o módulos que NO existen (npm, pip, etc.), APIs/métodos/propiedades/clases inventados, firmas de funciones incorrectas, opciones de configuración inexistentes, sintaxis imposible. REGLA: solo marca alucinación si estás SEGURO de que no existe. Ejemplos: "Array.prototype.chunk" NO existe en JS nativo; "redis.createClient" sí existe; "measureMemory" de node:perf_hooks no existe. No confundas estilo malo con alucinación.

3. BUGS (bugs): errores lógicos, off-by-one, null/undefined sin manejar, valores NaN propagados, manejo de errores ausente, race conditions, operadores equivocados, variables no definidas, edge cases que rompen.

4. OVERENGINEERING (sobre-ingeniería): abstracciones innecesarias, factories/clases/observables para tareas triviales, estrategias no usadas, código muerto, configuración superflua, violaciones obvias de YAGNI. Sé justo: código empresarial legítimo no es sobre-ingeniería; sobre-ingeniería es complejidad desproporcionada al problema.

REGLAS ESTRICTAS:
- Analiza SOLO el código proporcionado. No inventes problemas que no ves ni repitas el mismo problema en dos categorías.
- "lines" contiene números de línea REALES (1-indexed) donde ocurre el problema.
- "explanation" y "fix" en ESPAÑOL, concretos, accionables, sin markdown.
- Si una categoría está limpia, findings = [] y un summary breve positivo.
- Prioriza impacto real: mejor 5 hallazgos graves bien explicados que 15 nimios.
- Cada hallazgo debe tener máximo 2 frases en explanation y 1-2 en fix.

Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin backticks, sin texto antes ni después) con esta forma EXACTA:
{"summary":"resumen general del código en 2-3 frases","categories":{"security":{"summary":"1-2 frases","findings":[{"severity":"critical|high|medium|low|info","title":"título corto","lines":[1],"explanation":"...","fix":"..."}]},"hallucination":{"summary":"...","findings":[...]},"bugs":{"summary":"...","findings":[...]},"overengineering":{"summary":"...","findings":[...]}}}`

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('La respuesta de la IA no contiene JSON')
  }
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback
}

function normalizeFindings(v: unknown): Finding[] {
  if (!Array.isArray(v)) return []
  return v
    .slice(0, 12)
    .map((raw): Finding | null => {
      if (typeof raw !== 'object' || raw === null) return null
      const f = raw as Record<string, unknown>
      const severity = VALID_SEVERITIES.includes(f.severity as Severity)
        ? (f.severity as Severity)
        : 'medium'
      const title = asString(f.title, 'Hallazgo sin título').slice(0, 120)
      const lines = Array.isArray(f.lines)
        ? f.lines.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, 10)
        : []
      const explanation = asString(f.explanation, 'Sin explicación proporcionada.')
      const fix = asString(f.fix, 'Revisa esta sección manualmente.')
      return { severity, title, lines, explanation, fix }
    })
    .filter((f): f is Finding => f !== null)
}

function buildReport(parsed: Record<string, unknown>): VibeReport {
  const rawCategories =
    typeof parsed.categories === 'object' && parsed.categories !== null
      ? (parsed.categories as Record<string, unknown>)
      : {}

  const categories = {} as VibeReport['categories']
  let globalScore = 0

  for (const key of CATEGORY_KEYS) {
    const raw = typeof rawCategories[key] === 'object' && rawCategories[key] !== null
      ? (rawCategories[key] as Record<string, unknown>)
      : {}
    const findings = normalizeFindings(raw.findings)
    const score = scoreFromFindings(findings)
    categories[key] = {
      score,
      summary: asString(raw.summary, 'Categoría analizada sin observaciones.'),
      findings,
    }
    globalScore += score * CATEGORY_META[key].weight
  }

  let score = Math.round(globalScore)

  // Techo duro: un crítico en seguridad o alucinación es inaceutable para producción.
  // (código que filtra credenciales o ni siquiera puede ejecutarse)
  const hasCritical = (k: CategoryKey) =>
    categories[k].findings.some((f) => f.severity === 'critical')
  if (hasCritical('security') || hasCritical('hallucination')) {
    score = Math.min(score, 35)
  } else if (hasCritical('bugs') || hasCritical('overengineering')) {
    score = Math.min(score, 55)
  }

  return {
    score,
    verdict: verdictFromScore(score),
    summary: asString(parsed.summary, 'Análisis completado.'),
    categories,
  }
}

async function callLLM(
  llm: LlmClient,
  code: string,
  language: string,
  wasTruncated: boolean,
) {
  const truncationNote = wasTruncated
    ? '\n\nNOTA: el código fue truncado por longitud; analiza solo lo que ves.'
    : ''
  const userPrompt = `Lenguaje: ${language === 'auto' ? 'detección automática' : language}\n\nAnaliza este código:\n\n${code}${truncationNote}`

  // Primer intento + reintento con recordatorio de formato estricto
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: Array<{ role: 'assistant' | 'user'; content: string }> = [
      { role: 'assistant', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          attempt === 0
            ? userPrompt
            : `${userPrompt}\n\nIMPORTANTE: tu respuesta anterior no fue JSON válido. Responde ÚNICAMENTE con el objeto JSON, sin ningún texto adicional.`,
      },
    ]
    const content = await llm.complete(messages)
    if (content && content.trim().length > 0) {
      try {
        return extractJson(content)
      } catch {
        if (attempt === 1) throw new Error('La IA devolvió una respuesta ilegible. Inténtalo de nuevo.')
      }
    }
  }
  throw new Error('La IA no devolvió respuesta. Inténtalo de nuevo.')
}

const SNIPPET_AUDITS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return NextResponse.json(
      { error: 'Petición inválida. Envía { code, language?, title? }.' },
      { status: 400 },
    )
  }

  // Rate limit antes de llamar al LLM: la cuota quemada es de créditos
  const rl = rateLimit(`snippet-audit:${clientKeyFrom(req)}`, SNIPPET_AUDITS_PER_HOUR, HOUR_MS)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Límite de ${SNIPPET_AUDITS_PER_HOUR} auditorías de snippet por hora alcanzado. Reintenta en ~${Math.ceil(rl.retryAfterSec / 60)} minutos.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const code = body.code
  const wasTruncated = code.length > MAX_CODE_LENGTH
  const finalCode = wasTruncated ? code.slice(0, MAX_CODE_LENGTH) : code
  const title =
    body.title?.trim() ||
    code.split('\n').find((l) => l.trim().length > 3)?.trim().slice(0, 80) ||
    'Snippet sin título'

  try {
    const llm = await getLLM()
    if (!llm) {
      return NextResponse.json(
        {
          error:
            'IA no configurada en esta instancia. Define una API key (GEMINI_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, ZAI_API_KEY u OLLAMA_MODEL) o usa el auditor de repos, que funciona sin IA.',
        },
        { status: 503 },
      )
    }
    const parsed = await callLLM(llm, finalCode, body.language, wasTruncated)
    const report = buildReport(parsed)
    const codeLines = code.split('\n').length

    let id: string
    try {
      const saved = await db.vibeCheck.create({
        data: {
          title: title.slice(0, 120),
          language: body.language,
          score: report.score,
          verdict: report.verdict,
          codeLines,
          report: JSON.stringify(report),
        },
      })
      id = saved.id
    } catch (dbError) {
      console.error('[vibecheck] DB save failed:', dbError)
      id = `ephemeral-${Date.now()}`
    }

    return NextResponse.json({ id, report })
  } catch (error) {
    console.error('[vibecheck] analyze failed:', error)
    const message =
      error instanceof Error ? error.message : 'Error desconocido durante el análisis'
    return NextResponse.json(
      { error: `No se pudo completar la auditoría: ${message}` },
      { status: 500 },
    )
  }
}
