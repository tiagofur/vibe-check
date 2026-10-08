import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { classifyFinding, matchBench, type BenchEntry } from '../src/lib/bench'
import { scanRepo } from '../src/lib/repo-scan'
import type { RepoFinding } from '../src/lib/repo-types'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'tests/fixtures/vibe-coded-repo')
const GROUND_TRUTH = join(ROOT, 'tests/ground-truths/vibe-coded-repo.json')

const finding = (over: Partial<RepoFinding>): RepoFinding => ({
  file: 'src/x.ts',
  severity: 'medium',
  category: 'bugs',
  title: 'Hallazgo',
  lines: [1],
  explanation: '',
  fix: '',
  origin: 'scan',
  ...over,
})

describe('matchBench · unidades del matcher', () => {
  it('clasifica los hallazgos del motor a kinds del benchmark', () => {
    expect(classifyFinding(finding({ title: 'Import fantasma: módulo local inexistente' }))).toBe('phantom-import')
    expect(classifyFinding(finding({ title: 'Dependencia fantasma: "x" no está en package.json' }))).toBe('phantom-dep')
    expect(classifyFinding(finding({ title: 'AWS Access Key', category: 'security' }))).toBe('secret')
    expect(classifyFinding(finding({ title: 'Archivo de entorno commiteado (1)', category: 'security' }))).toBe('env-committed')
    expect(classifyFinding(finding({ title: '1 archivo(s) huérfano(s)', category: 'overengineering' }))).toBe('orphan')
    expect(classifyFinding(finding({ title: '2 dependencia(s) sin uso', category: 'overengineering' }))).toBe('unused-dep')
    expect(classifyFinding(finding({ title: 'Tests saltados', file: 'src/a.test.ts' }))).toBe('fake-test')
    // un bug de IA en un archivo de NO-test no participa del benchmark
    expect(classifyFinding(finding({ title: 'off-by-one', file: 'src/calc.ts' }))).toBeNull()
  })

  it('file, name y titleIncludes filtran el match; un hallazgo no consume dos entradas', () => {
    const findings: RepoFinding[] = [
      finding({ title: 'AWS Access Key', category: 'security', file: 'src/a.ts' }),
      finding({ title: 'Token de GitHub', category: 'security', file: 'src/b.ts' }),
    ]
    const entries: BenchEntry[] = [
      { id: 'ok-aws', kind: 'secret', file: 'src/a.ts' },
      { id: 'espera-otro-archivo', kind: 'secret', file: 'src/otro.ts' },
      { id: 'ok-gh-con-titulo', kind: 'secret', file: 'src/b.ts', titleIncludes: 'GitHub' },
    ]
    const res = matchBench(entries, findings)
    expect(res.matched.map((m) => m.entry.id)).toEqual(['ok-aws', 'ok-gh-con-titulo'])
    expect(res.missed.map((m) => m.id)).toEqual(['espera-otro-archivo'])
    expect(res.falsePositives).toEqual([])
    expect(res.recall).toBeCloseTo(2 / 3)
    expect(res.precision).toBe(1)
  })

  it('hallazgos sin expectativa son falsos positivos y bajan la precisión', () => {
    const res = matchBench([{ id: 'e1', kind: 'secret', file: 'src/a.ts' }], [
      finding({ title: 'AWS Access Key', category: 'security', file: 'src/a.ts' }),
      finding({ title: '1 archivo(s) huérfano(s)', category: 'overengineering' }),
    ])
    expect(res.falsePositives).toHaveLength(1)
    expect(res.precision).toBe(0.5)
    expect(res.recall).toBe(1)
  })
})

describe('benchmark dorado · fixture vibe-coded-repo', () => {
  function load(dir: string, rel = ''): { path: string; content: string }[] {
    const out: { path: string; content: string }[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...load(abs, relPath))
      else out.push({ path: relPath, content: readFileSync(abs, 'utf8') })
    }
    return out
  }

  it('recall y precisión 100% contra el ground truth declarado', () => {
    const gt = JSON.parse(readFileSync(GROUND_TRUTH, 'utf8')) as { entries: BenchEntry[] }
    const files = load(FIXTURE).map((f) => ({ ...f, content: f.content }))
    const scan = scanRepo(files)
    const bench = matchBench(gt.entries, scan.findings)
    // visibilidad en la salida del test: las métricas impresas son el deliverable
    console.log(
      `📏 Benchmark fixture — esperados: ${bench.expected}, TP: ${bench.matched.length}, FN: ${bench.missed.length}, FP: ${bench.falsePositives.length}, recall: ${(bench.recall * 100).toFixed(0)}%, precisión: ${(bench.precision * 100).toFixed(0)}%`,
    )
    if (bench.missed.length > 0) {
      console.log('   Faltantes:', bench.missed.map((m) => m.id).join(', '))
    }
    if (bench.falsePositives.length > 0) {
      console.log('   No esperados:', bench.falsePositives.map((f) => `${f.title} @ ${f.file}`).join(', '))
    }
    expect(bench.missed, 'defectos plantados que el motor NO detectó').toEqual([])
    expect(bench.falsePositives, 'hallazgos que no corresponden a ningún defecto plantado').toEqual([])
    expect(bench.recall).toBe(1)
    expect(bench.precision).toBe(1)
  })
})

describe('cli.ts --bench (E2E)', () => {
  it('imprime las métricas contra el ground truth del fixture', () => {
    const r = spawnSync('bun', ['cli.ts', FIXTURE, '--bench', GROUND_TRUTH], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60_000,
    })
    expect(r.status).toBe(1) // el fixture es PELIGRO a propósito
    expect(r.stdout).toContain('📏 Benchmark vs ground truth:')
    expect(r.stdout).toContain('Recall: 100% · Precisión: 100%')
    expect(r.stdout).not.toContain('Faltante:')
    expect(r.stdout).not.toContain('No esperado:')
  })

  it('--bench --json incluye el bloque de métricas', () => {
    const r = spawnSync('bun', ['cli.ts', FIXTURE, '--bench', GROUND_TRUTH, '--json'], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60_000,
    })
    const out = JSON.parse(r.stdout)
    expect(out.bench.expected).toBe(13)
    expect(out.bench.matched).toBe(13)
    expect(out.bench.recall).toBe(1)
    expect(out.bench.falsePositives).toEqual([])
  })
})
