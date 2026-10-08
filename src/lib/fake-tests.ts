// ─────────────────────────────────────────────────────────────
// VibeCheck · Detector determinista de "tests falsos"
// Suites que no pueden fallar, assertions tautológicas, cuerpos
// vacíos y tests saltados. Cero LLM: regexes conservadoras sobre
// el contenido, un hallazgo por archivo y tipo de defecto.
// ─────────────────────────────────────────────────────────────

import type { RepoFile, RepoFinding } from './repo-types'
import type { Severity } from './vibe-types'

/** *.test.ts(x) / *.spec.js / __tests__/** (JS/TS) */
export function isJsTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.[jt]sx?$/.test(path) ||
    (/\/__tests__\//.test(`/${path}`) && /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(path))
  )
}

/** test_*.py / *_test.py (pytest / unittest) */
export function isPyTestFile(path: string): boolean {
  return /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path)
}

export function isTestFile(path: string): boolean {
  return isJsTestFile(path) || isPyTestFile(path)
}

// Literales JS: números, strings con comillas simples/dobles/backtick, true/false/null/undefined
const LIT = String.raw`(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`(?:[^\`\\]|\\.)*\`)`

/** expect(<literal>).toBe(<mismo literal>) — la tautología clásica */
const TAUTO_PAIR_RE = new RegExp(
  String.raw`expect\(\s*(${LIT})\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*(${LIT})\s*\)`,
  'g',
)
/** expect(<mismo identificador>).toBe(<ese identificador>) — ej. expect(result).toBe(result) */
const TAUTO_IDENT_RE = /\bexpect\(\s*([A-Za-z_$][\w$.]*)\s*\)\s*\.\s*(?:toBe|toEqual)\(\s*\1\s*\)/g
/** expect(<literal truthy>).toBeTruthy() y su espejo toBeFalsy */
const TAUTO_TRUTHY_RE = new RegExp(
  String.raw`expect\(\s*(true|-?[1-9]\d*|'(?:[^'\\]|\\.)+'|"(?:[^"\\]|\\.)+")\s*\)\s*\.\s*toBeTruthy\(\s*\)`,
  'g',
)
const TAUTO_FALSY_RE = new RegExp(
  String.raw`expect\(\s*(false|0|-?0\.\d+|''|"")\s*\)\s*\.\s*toBeFalsy\(\s*\)`,
  'g',
)
/** it('…', () => {}) y la variante function () {} */
const EMPTY_ARROW_RE = /\b(?:it|test)\s*\(\s*(['"`])[^'"`]*\1\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}/g
const EMPTY_FN_RE = /\b(?:it|test)\s*\(\s*(['"`])[^'"`]*\1\s*,\s*(?:async\s*)?function\s*\(\s*\)\s*\{\s*\}/g
/** Tests saltados: .skip( / .todo( / xit / xdescribe */
const SKIPPED_RE = /\.(?:skip|todo)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(/g

/** Declaraciones de test y asserts, para detectar suites que no pueden fallar */
const JS_TEST_DECL_RE = /\b(?:it|test)\s*\(\s*['"`]/g
const JS_ASSERT_RE = /\bexpect\s*\(|\bassert(?:ion)?\s*[.(]|\bt\.(?:ok|equal|deepEqual|strictEqual|truthy|is)\b/g

const PY_TEST_DECL_RE = /^\s*(?:async\s+)?def\s+test_\w+/gm
const PY_ASSERT_RE = /\bassert\b|self\.assert[A-Za-z]*\(|\bpytest\.(?:raises|fail|warns)/g
const PY_TAUTO_RE = /^\s*assert\s+True\s*(?:#.*)?$/gm
const PY_SKIP_RE = /@pytest\.mark\.(?:skip|xfail)|@pytest\.skip|@unittest\.skip/g

function normalizeLit(lit: string): string {
  const t = lit.trim()
  const first = t[0]
  if ((first === "'" || first === '"' || first === '`') && t.at(-1) === first) {
    return t.slice(1, -1)
  }
  return t
}

function linesOf(content: string, matches: RegExpMatchArray[], cap = 4): number[] {
  const lines: number[] = []
  for (const m of matches) {
    const needle = m[0]
    const idx = content.indexOf(needle)
    if (idx === -1) continue
    const line = content.slice(0, idx).split('\n').length
    if (!lines.includes(line)) lines.push(line)
    if (lines.length >= cap) break
  }
  return lines
}

function collect(content: string, re: RegExp): RegExpMatchArray[] {
  return [...content.matchAll(re)]
}

interface Rule {
  key: string
  title: string
  severity: Severity
  explanation: string
  fix: string
}

const JS_RULES: Record<string, Omit<Rule, 'key'>> = {
  tautology: {
    title: 'Assertions tautológicas en tests',
    severity: 'medium',
    explanation:
      'El test compara un valor consigo mismo (ej. expect(true).toBe(true)). Formalmente pasa, pero no prueba ninguna conducta: es el relleno clásico con el que la IA "cumple" el requisito de tener tests.',
    fix: 'Sustituye la tautología por assertions sobre el resultado real de la función bajo test (o elimina el test si no hay nada que verificar).',
  },
  noAssertions: {
    title: 'Suite de tests que no puede fallar',
    severity: 'high',
    explanation:
      'El archivo declara tests pero no contiene ni un solo assert/expect: la suite pasa siempre, sin importar lo que rompa el código. Un suite así solo da falsa confianza.',
    fix: 'Añade assertions que verifiquen resultados concretos (y errores esperados) en cada test, o marca el archivo como pendiente de escribir de verdad.',
  },
  emptyBody: {
    title: 'Tests con cuerpo vacío',
    severity: 'medium',
    explanation:
      'Hay tests cuyo cuerpo es un bloque vacío: se cuentan como "tests que pasan" en el resumen sin ejecutar nada.',
    fix: 'Implementa el test o elimínalo; un placeholder silencioso contamina la métrica de cobertura.',
  },
  skipped: {
    title: 'Tests saltados',
    severity: 'low',
    explanation:
      'Hay tests marcados para saltarse (.skip, xit, .todo). Un puñado de skips recién generado suele significar que la IA dejó a medias los casos difíciles.',
    fix: 'Reactiva los tests, arréglalos o bórralos con un issue de seguimiento; no los dejes durmiendo en la suite.',
  },
}

function makeRuleFinding(
  file: string,
  rule: Omit<Rule, 'key'>,
  lines: number[],
): RepoFinding {
  return {
    file,
    severity: rule.severity,
    category: 'bugs',
    title: rule.title,
    lines,
    explanation: rule.explanation,
    fix: rule.fix,
    origin: 'scan',
  }
}

/** Analiza los archivos de test de un repo y devuelve hallazgos + archivos sospechosos */
export function detectFakeTests(files: RepoFile[]): {
  findings: RepoFinding[]
  suspiciousFiles: string[]
} {
  const findings: RepoFinding[] = []
  const suspicious = new Set<string>()

  for (const f of files) {
    const content = f.content

    if (isJsTestFile(f.path)) {
      // Tautologías: pares de literales idénticos, identificadores iguales, truthy/falsy trivial
      const tautoMatches = [
        ...collect(content, TAUTO_PAIR_RE).filter((m) => {
          const a = m[1] ?? ''
          const b = m[2] ?? ''
          return a !== undefined && b !== undefined && normalizeLit(a) === normalizeLit(b)
        }),
        ...collect(content, TAUTO_IDENT_RE),
        ...collect(content, TAUTO_TRUTHY_RE),
        ...collect(content, TAUTO_FALSY_RE),
      ]
      if (tautoMatches.length > 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.tautology!, linesOf(content, tautoMatches)))
        suspicious.add(f.path)
      }

      // Cuerpos vacíos
      const emptyMatches = [...collect(content, EMPTY_ARROW_RE), ...collect(content, EMPTY_FN_RE)]
      if (emptyMatches.length > 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.emptyBody!, linesOf(content, emptyMatches)))
        suspicious.add(f.path)
      }

      // Saltados
      const skipMatches = collect(content, SKIPPED_RE)
      if (skipMatches.length > 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.skipped!, linesOf(content, skipMatches)))
        suspicious.add(f.path)
      }

      // Suite que no puede fallar: declara tests y no hay ni un assert
      const decls = collect(content, JS_TEST_DECL_RE).length
      const asserts = collect(content, JS_ASSERT_RE).length
      if (decls > 0 && asserts === 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.noAssertions!, [1]))
        suspicious.add(f.path)
      }
    }

    if (isPyTestFile(f.path)) {
      const decls = collect(content, PY_TEST_DECL_RE).length
      const tautoMatches = collect(content, PY_TAUTO_RE)
      const skipMatches = collect(content, PY_SKIP_RE)
      const asserts = collect(content, PY_ASSERT_RE).length

      if (tautoMatches.length > 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.tautology!, linesOf(content, tautoMatches)))
        suspicious.add(f.path)
      }
      if (skipMatches.length > 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.skipped!, linesOf(content, skipMatches)))
        suspicious.add(f.path)
      }
      if (decls > 0 && asserts === 0) {
        findings.push(makeRuleFinding(f.path, JS_RULES.noAssertions!, [1]))
        suspicious.add(f.path)
      }
    }
  }

  return { findings, suspiciousFiles: [...suspicious].sort() }
}
