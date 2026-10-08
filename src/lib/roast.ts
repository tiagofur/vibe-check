// ─────────────────────────────────────────────────────────────
// VibeCheck · Modo roast 🔥
// Resumen sarcástico y compartible, 100% determinista: mismas
// condiciones → mismas frases, sin LLM. Va separado del reporte
// serio: es humor, no evidencia.
// ─────────────────────────────────────────────────────────────

import type { RepoReport, StructuralCheck } from './repo-types'
import type { Verdict } from './vibe-types'

/** Señales agregadas que disparan reglas de roast (counts, 0 = no aplica) */
export interface RoastSignals {
  secrets: number
  envCommitted: number
  phantomDeps: number
  brokenImports: number
  unusedDeps: number
  orphans: number
  fakeTests: number
}

export interface RoastInput {
  repoName: string
  verdict: Verdict
  signals: RoastSignals
  diff?: { excludedFindings: number } | null
}

/** Mapa id→count de los structural checks del reporte completo */
function structuralCounts(structural: StructuralCheck[]): Partial<Record<string, number>> {
  return Object.fromEntries(structural.map((c) => [c.id, c.count]))
}

/** En la web, las señales salen de los structural checks del reporte */
export function signalsFromReport(report: RepoReport): RoastSignals {
  const c = structuralCounts(report.structural)
  return {
    secrets: c['secrets'] ?? 0,
    envCommitted: c['env-committed'] ?? 0,
    phantomDeps: c['phantom-deps'] ?? 0,
    brokenImports: c['broken-imports'] ?? 0,
    unusedDeps: c['unused-deps'] ?? 0,
    orphans: c['orphans'] ?? 0,
    fakeTests: c['test-integrity'] ?? 0,
  }
}

const n = (s: string, count: number): string =>
  s.replace(/\{n\}/g, String(count)).replace(/\{s\}/g, count === 1 ? '' : 's')

export const ROAST: Record<Verdict, string[]> = {
  'SHIP IT': [
    'Aburridamente sólido. Intenté encontrar algo que roastear y fallé: es lo más emocionante que le puede pasar a un repo.',
    'Este repo come ensalada, hace ejercicio y duerme 8 horas. No hay nada que roastear.',
  ],
  'CASI LISTO': [
    'Casi listo: como una serie que se veía muy bien hasta el último capítulo.',
    'Nada grave, pero con suficientes detalles raros como para no prestarle tu coche.',
  ],
  SOSPECHOSO: [
    'Este repo tiene más banderas rojas que un desfile militar.',
    'Hay cosas que no cuadran aquí. Y no en el sentido bonito de "misterio", sino en el de "auditoría".',
  ],
  PELIGRO: [
    'Este repo fue generado más rápido de lo que fue entendido.',
    'La buena noticia: el código corre. La mala: eso es lo único que hace.',
  ],
}

interface RoastRule {
  key: keyof RoastSignals
  lines: string[]
}

/** Ordenadas por impacto: si hay muchas, ganan las primeras */
const RULES: RoastRule[] = [
  {
    key: 'secrets',
    lines: [
      'Tus credenciales ya son más públicas que tu README. Revócalas antes de que lo haga otro por ti.',
      'Incluir API keys en un repo público no es "transparencia", es "regalo".',
    ],
  },
  {
    key: 'fakeTests',
    lines: [
      'Tus tests no pueden fallar. Técnicamente tampoco pueden aprobar: solo existen.',
      'Suite de tests impecable: 100% verde, 0% útil.',
    ],
  },
  {
    key: 'phantomDeps',
    lines: [
      'Importaste {n} paquete{s} que no existen en package.json. Confianza admirable en el universo.',
      'Hay dependencias que solo existen en la imaginación de la IA. npm no las va a encontrar.',
    ],
  },
  {
    key: 'brokenImports',
    lines: [
      'Hay imports a archivos que nadie escribió. Código espectral: duele solo al compilar.',
      'Importas módulos que no existen; el build todavía está procesando el trauma.',
    ],
  },
  {
    key: 'envCommitted',
    lines: [
      'El .env viajó commiteado. Los secretos no son dependencias: no se instalan solos.',
      'Comitear el .env es la forma más eficiente de convertir "proyecto" en "incidente".',
    ],
  },
  {
    key: 'orphans',
    lines: [
      '{n} archivo{s} que nadie importa: la IA lo{s} escribió "por si acaso", y "por si acaso" nunca llegó.',
      '{n} módulo{s} huérfano{s}. En este repo, la soledad no es un sentimiento: es una métrica.',
    ],
  },
  {
    key: 'unusedDeps',
    lines: [
      '{n} dependencia{s} declarada{s} que nadie usa. Peso muerto, pero con estilo.',
      'Declaraste {n} dependencia{s} que nadie importa: npm install agradece el cardio.',
    ],
  },
]

const DIFF_LINES = [
  'Además, {n} hallazgo{s} pre-existentes quedaron fuera del score: el resto del repo ya es museo.',
  'Modo diff activado: {n} hallazgo{s} heredado{s} se quedaron fuera. El daño nuevo es todo tuyo.',
]

const CLEAN_LINES = [
  'Sospechosamente limpio. O es un gran repo, o los hallazgos se están escondiendo muy bien.',
  'Nada que roastear. Acepto la derrota… esta vez.',
]

/** djb2: hash estable para que el mismo repo dé siempre el mismo roast */
function hashSeed(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0
  return h
}

function pick(seed: string, pool: string[]): string {
  return pool[hashSeed(seed) % pool.length] ?? pool[0] ?? ''
}

const MAX_LINES = 5

/** Devuelve 1 a 5 frases de roast, siempre deterministas */
export function roastRepo(input: RoastInput): string[] {
  const seed = input.repoName
  const lines: string[] = [pick(`${seed}:opener`, ROAST[input.verdict])]

  if ((input.diff?.excludedFindings ?? 0) > 0) {
    lines.push(n(pick(`${seed}:diff`, DIFF_LINES), input.diff?.excludedFindings ?? 0))
  }

  for (const rule of RULES) {
    if (lines.length >= MAX_LINES) break
    const count = input.signals[rule.key]
    if (count > 0) lines.push(n(pick(`${seed}:${rule.key}`, rule.lines), count))
  }

  if (lines.length === 1) lines.push(pick(`${seed}:clean`, CLEAN_LINES))
  return lines
}

/** Versión markdown para compartir (PRs, Discord, redes) */
export function roastToMarkdown(repoName: string, lines: string[]): string {
  return [
    `## 🔥 Roast de VibeCheck — ${repoName}`,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    '> Modo roast: humor, no evidencia. El reporte serio está en VibeCheck.',
  ].join('\n')
}
