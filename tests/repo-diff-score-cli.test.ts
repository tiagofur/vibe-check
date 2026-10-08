import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedPaths, diffTrees } from '../src/lib/repo-diff'
import { mergeAndScore } from '../src/lib/repo-score'
import type { RepoFinding } from '../src/lib/repo-types'

describe('diffTrees', () => {
  it('clasifica added / modified / deleted', () => {
    const base = new Map([
      ['a.ts', 'uno'],
      ['b.ts', 'dos'],
      ['c.ts', 'tres'],
    ])
    const head = new Map([
      ['a.ts', 'uno'], // sin cambios
      ['b.ts', 'dos!'], // modificado
      ['d.ts', 'cuatro'], // añadido
    ])
    const diff = diffTrees(base, head)
    expect(diff.added).toEqual(['d.ts'])
    expect(diff.modified).toEqual(['b.ts'])
    expect(diff.deleted).toEqual(['c.ts'])
    expect([...changedPaths(diff)]).toEqual(['b.ts', 'd.ts'])
  })

  it('árboles idénticos → diff vacío', () => {
    const t = new Map([['x.ts', 'hola']])
    expect(diffTrees(t, new Map(t))).toEqual({ added: [], modified: [], deleted: [] })
  })
})

const finding = (file: string, severity: RepoFinding['severity'], category: RepoFinding['category']): RepoFinding => ({
  file,
  severity,
  category,
  title: `${severity} en ${file}`,
  lines: [1],
  explanation: '',
  fix: '',
  origin: 'scan',
})

describe('mergeAndScore (fuente compartida route/CLI)', () => {
  it('techos duros: crítico de seguridad clava el score en 35', () => {
    const { score } = mergeAndScore([
      finding('a.ts', 'critical', 'security'),
      finding('a.ts', 'low', 'bugs'),
    ], [])
    expect(score).toBeLessThanOrEqual(35)
  })

  it('modo diff: solo puntúan los hallazgos de archivos cambiados', () => {
    const { score, excludedCount, categories } = mergeAndScore([
      finding('nuevo.ts', 'critical', 'security'),
      finding('viejo.ts', 'critical', 'security'),
      finding('viejo.ts', 'high', 'bugs'),
    ], [], { onlyFiles: new Set(['nuevo.ts']) })
    // solo el crítico de nuevo.ts puntúa (100-25=75)… pero el techo duro ante
    // críticos de seguridad aplica también en modo diff → 35
    expect(excludedCount).toBe(2)
    expect(score).toBe(35)
    expect(categories.security.findings.map((f) => f.file)).toEqual(['nuevo.ts'])
    expect(categories.bugs.findings).toEqual([])
  })

  it('modo diff sin críticos: score limpio sobre solo los cambios', () => {
    const { score, excludedCount } = mergeAndScore([
      finding('viejo.ts', 'critical', 'security'),
    ], [], { onlyFiles: new Set(['nuevo.ts']) })
    expect(excludedCount).toBe(1)
    expect(score).toBe(100)
  })

  it('sin onlyFiles el comportamiento es el de siempre', () => {
    const clean = mergeAndScore([], [])
    expect(clean.score).toBe(100)
    expect(clean.excludedCount).toBe(0)
  })
})

interface CliRun {
  status: number
  stdout: string
  stderr: string
}

/** El CLI sale con código 1 en PELIGRO por diseño: capturamos stdout igual */
function runCli(args: string[]): CliRun {
  try {
    const stdout = execFileSync('bun', ['cli.ts', ...args], {
      encoding: 'utf8',
      cwd: join(import.meta.dirname, '..'),
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('CLI (E2E sobre el fixture vibe-coded)', () => {
  const fixture = join(import.meta.dirname, 'fixtures/vibe-coded-repo')

  it('audita la carpeta y reporta los hallazgos plantados en JSON', () => {
    const { status, stdout } = runCli([fixture, '--json'])
    expect(status).toBe(1) // PELIGRO → gate de CI
    const report = JSON.parse(stdout) as {
      score: number
      verdict: string
      checks: { missingDeps: string[]; orphanFiles: string[] }
      scoreExplanation?: { deductions: { cost: number; count: number }[]; cap: unknown }
    }
    expect(report.verdict).toBe('PELIGRO')
    expect(report.score).toBeLessThanOrEqual(35)
    expect(report.checks.missingDeps).toContain('left-pad-x')
    expect(report.checks.orphanFiles).toContain('src/billing/pagos.ts')
    // score explicable: el JSON trae la atribución de puntos
    expect(report.scoreExplanation?.deductions.length).toBeGreaterThan(0)
    expect(report.scoreExplanation?.cap).not.toBeNull()
  })

  it('exit code 1 con veredicto PELIGRO en salida legible', () => {
    const { status, stdout } = runCli([fixture])
    expect(status).toBe(1)
    expect(stdout).toContain('Vibe Score')
    expect(stdout).toContain('left-pad-x')
    // score explicable también en modo humano
    expect(stdout).toContain('¿Por qué')
    expect(stdout).toContain('pts')
  })

  it('sin argumentos imprime uso y sale 1', () => {
    const { status, stderr } = runCli([])
    expect(status).toBe(1)
    expect(stderr).toContain('Uso:')
  })
})
