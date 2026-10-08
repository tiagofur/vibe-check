import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isScannablePath, riskScore, scanRepo } from '../src/lib/repo-scan'
import { selectAuditFiles } from '../src/lib/repo-llm'
import type { RepoFile } from '../src/lib/repo-types'
import { scoreFromFindings, verdictFromScore } from '../src/lib/vibe-types'

// ── Fixture: repo "vibe-coded" con defectos plantados ─────────

function loadFixtureDir(dir: string, rel = ''): RepoFile[] {
  const out: RepoFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...loadFixtureDir(abs, relPath))
    else if (entry.isFile()) {
      const size = statSync(abs).size
      if (!isScannablePath(relPath, size)) continue
      out.push({ path: relPath, content: readFileSync(abs, 'utf8') })
    }
  }
  return out
}

function loadVibeCodedRepo(): RepoFile[] {
  return loadFixtureDir(fileURLToPath(new URL('./fixtures/vibe-coded-repo', import.meta.url)))
}

const fixture = loadVibeCodedRepo()

describe('scanRepo · fixture vibe-coded-repo (defectos plantados)', () => {
  const { findings, checks, stats } = scanRepo(fixture)

  it('detecta el import fantasma a módulo local inexistente', () => {
    const ghost = findings.find(
      (f) => f.title.startsWith('Import fantasma') && f.file === 'src/server.ts',
    )
    expect(ghost, JSON.stringify(findings, null, 2)).toBeDefined()
    expect(ghost?.category).toBe('hallucination')
    expect(ghost?.severity).toBe('high')
  })

  it('detecta la dependencia fantasma left-pad-x', () => {
    expect(findings.some((f) => f.title.includes('left-pad-x'))).toBe(true)
    expect(checks.missingDeps).toContain('left-pad-x')
  })

  it('detecta los secretos plantados (AWS y Stripe) como críticos', () => {
    const security = findings.filter((f) => f.category === 'security' && f.severity === 'critical')
    expect(security.some((f) => f.title.includes('AWS Access Key'))).toBe(true)
    expect(security.some((f) => f.title.includes('Stripe live key'))).toBe(true)
  })

  it('detecta el .env commiteado y su URL de base de datos con contraseña', () => {
    expect(findings.some((f) => f.title.startsWith('Archivo de entorno commiteado'))).toBe(true)
    expect(
      findings.some((f) => f.category === 'security' && f.title.includes('base de datos')),
    ).toBe(true)
    expect(checks.envFiles).toContain('.env')
  })

  it('detecta lodash como dependencia sin uso (declarada y nunca importada)', () => {
    const unused = findings.find((f) => f.title.includes('dependencia(s) sin uso'))
    expect(unused).toBeDefined()
    expect(unused?.explanation).toContain('lodash')
    // express sí se usa y typescript está en devDependencies: no deben contarse
    expect(unused?.explanation).not.toContain('express')
    expect(unused?.explanation).not.toContain('typescript')
  })

  it('detecta src/billing/pagos.ts como archivo huérfano', () => {
    expect(checks.orphanFiles).toContain('src/billing/pagos.ts')
  })

  it('detecta los tests falsos plantados (tautología, vacío, skip y suite sin asserts)', () => {
    const loginTest = findings.filter((f) => f.file === 'src/auth/login.test.ts')
    expect(loginTest.map((f) => f.title)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tautológicas'),
        expect.stringContaining('cuerpo vacío'),
        expect.stringContaining('saltados'),
      ]),
    )
    // session.test.ts declara tests sin ni un assert: no puede fallar
    expect(
      findings.some(
        (f) => f.file === 'src/auth/session.test.ts' && f.title.includes('no puede fallar'),
      ),
    ).toBe(true)
    expect(checks.suspiciousTestFiles).toEqual(
      expect.arrayContaining(['src/auth/login.test.ts', 'src/auth/session.test.ts']),
    )
    // el import de vitest está declarado en devDependencies: no es dependencia fantasma
    expect(checks.missingDeps).not.toContain('vitest')
  })

  it('NO marca falsos positivos (express, node:crypto, manifiesto válido)', () => {
    expect(findings.some((f) => f.title.includes('express'))).toBe(false)
    expect(findings.some((f) => f.title.includes('crypto'))).toBe(false)
    expect(findings.some((f) => f.title.includes('package.json inválido'))).toBe(false)
  })

  it('expone los chequeos estructurales coherentes con lo plantado', () => {
    expect(checks.hasManifest).toBe(true)
    expect(checks.manifestName).toBe('package.json')
    expect(checks.brokenImports).toContain('src/server.ts')
    expect(checks.secretCount).toBeGreaterThanOrEqual(3)
    expect(stats.languages).toContain('TypeScript')
    expect(stats.totalLines).toBeGreaterThan(0)
  })
})

describe('scanRepo · casos límite', () => {
  it('sin manifiesto: no infiere deps fantasma pero sí detecta imports rotos', () => {
    const res = scanRepo([
      { path: 'app.ts', content: `import { x } from './missing'\nexport const y = x\n` },
    ])
    expect(res.checks.hasManifest).toBe(false)
    expect(res.checks.missingDeps).toEqual([])
    expect(res.findings.some((f) => f.title.startsWith('Import fantasma'))).toBe(true)
  })

  it('el auto-import del propio paquete no es dependencia fantasma', () => {
    const res = scanRepo([
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'mi-lib', dependencies: {} }),
      },
      { path: 'test.js', content: `import { slugify } from 'mi-lib'\nconsole.log(slugify)\n` },
    ])
    expect(res.checks.missingDeps).toEqual([])
  })

  it('los builtins de node (con y sin prefijo node:) no son fantasmas', () => {
    const res = scanRepo([
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'x', dependencies: {} }),
      },
      {
        path: 'a.js',
        content: `import { readFile } from 'node:fs'\nimport { join } from 'path'\nconsole.log(readFile, join)\n`,
      },
    ])
    expect(res.checks.missingDeps).toEqual([])
  })

  it('resuelve imports sin extensión y vía index/ del directorio', () => {
    const res = scanRepo([
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'x', dependencies: {} }),
      },
      { path: 'main.ts', content: `import { all } from './src/a'\nconsole.log(all)\n` },
      { path: 'src/a.ts', content: `import { h } from './helper'\nimport { i } from './lib'\nexport const all = [h, i]\n` },
      { path: 'src/helper.ts', content: 'export const h = 1\n' },
      { path: 'src/lib/index.ts', content: 'export const i = 2\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
    expect(res.checks.orphanFiles).toEqual([])
  })

  it('package.json corrupto produce un hallazgo high de bugs', () => {
    const res = scanRepo([
      { path: 'package.json', content: '{ name: roto,,' },
      { path: 'a.ts', content: 'export const a = 1\n' },
    ])
    const bad = res.findings.find((f) => f.title === 'package.json inválido')
    expect(bad?.severity).toBe('high')
    expect(bad?.category).toBe('bugs')
  })

  it('riskScore rankea auth por encima de tests', () => {
    expect(riskScore('src/auth/login.ts')).toBeGreaterThan(riskScore('src/login.test.ts'))
  })
})

describe('scanRepo · aliases de tsconfig/jsconfig', () => {
  const pkg = { path: 'package.json', content: JSON.stringify({ name: 'x', dependencies: {} }) }

  it('resuelve @/ vía compilerOptions.paths: sin fantasmas ni huérfanos', () => {
    const res = scanRepo([
      pkg,
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }) },
      { path: 'app/page.tsx', content: `import { hola } from '@/lib/saludo'\nexport default () => hola\n` },
      { path: 'src/lib/saludo.ts', content: 'export const hola = 1\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
    expect(res.checks.missingDeps).toEqual([])
    expect(res.checks.orphanFiles).toEqual([])
  })

  it('un alias que no resuelve a nada sigue marcándose como fantasma', () => {
    const res = scanRepo([
      pkg,
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }) },
      { path: 'a.tsx', content: `import { x } from '@/lib/missing'\nexport const y = x\n` },
    ])
    expect(res.findings.some((f) => f.title.startsWith('Import fantasma'))).toBe(true)
  })

  it('imports a directorios generados (.next) no se marcan: no son verificables', () => {
    const res = scanRepo([
      pkg,
      { path: 'next-env.d.ts', content: `import "./.next/dev/types/routes.d.ts"\n` },
      { path: 'a.ts', content: 'export const a = 1\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
  })

  it('tolera tsconfig con comentarios y trailing commas', () => {
    const res = scanRepo([
      pkg,
      {
        path: 'tsconfig.json',
        content: `{\n  // paths del proyecto\n  "compilerOptions": {\n    "paths": { "@/*": ["./src/*"], },\n  },\n}`,
      },
      { path: 'a.ts', content: `import { x } from '@/x'\nexport const y = x\n` },
      { path: 'src/x.ts', content: 'export const x = 1\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
  })

  it('el /* de "@/…" y los globs "**/*.ts" no se confunden con comentarios', () => {
    // réplica del tsconfig típico de Next: sin esto, el stripper de comentarios
    // borra el mapping completo y todos los @/ vuelven a ser "fantasmas"
    const res = scanRepo([
      pkg,
      {
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: { paths: { '@/*': ['./src/*'] } },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        }),
      },
      { path: 'app/page.tsx', content: `import { hola } from '@/lib/saludo'\nexport default () => hola\n` },
      { path: 'src/lib/saludo.ts', content: 'export const hola = 1\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
    expect(res.checks.orphanFiles).toEqual([])
  })

  it('jsconfig.json también sirve de fuente de aliases', () => {
    const res = scanRepo([
      pkg,
      { path: 'jsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@components/*': ['./ui/*'] } } }) },
      { path: 'app.ts', content: `import { btn } from '@components/btn'\nconsole.log(btn)\n` },
      { path: 'ui/btn.ts', content: 'export const btn = 1\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
    expect(res.checks.orphanFiles).toEqual([])
  })

  it('aliases de una sola letra no capturan imports que no les corresponden', () => {
    // '#' mapea a src, pero 'react' no empieza con '#' y no debe tocarse
    const res = scanRepo([
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'x', dependencies: { react: '19' } }),
      },
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '#*': ['./src/*'] } } }) },
      { path: 'a.tsx', content: `import { useState } from 'react'\nimport { u } from '#utils'\nexport const q = [useState, u]\n` },
      { path: 'src/utils.ts', content: 'export const u = 1\n' },
    ])
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
    expect(res.checks.missingDeps).toEqual([])
  })

  it('un alias sin * no captura imports que solo comparten prefijo', () => {
    const res = scanRepo([
      pkg,
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@lib': ['./src/lib'] } } }) },
      { path: 'a.ts', content: `import { x } from '@libfoo'\nexport const y = x\n` },
    ])
    // '@libfoo' no lo captura '@lib': queda como paquete externo, no como ruta local fantasma
    expect(res.findings.some((f) => f.title.startsWith('Import fantasma'))).toBe(false)
    expect(res.checks.missingDeps).toContain('@libfoo')
  })
})

describe('scanRepo · árbol parcial (top-N por riesgo) y archivos solo-ruta', () => {
  const pkg = { path: 'package.json', content: JSON.stringify({ name: 'x', dependencies: {} }) }
  const tsconfig = {
    path: 'tsconfig.json',
    content: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  }
  const page = {
    path: 'app/page.tsx',
    content: `import { hola } from '@/lib/saludo'\nexport default () => hola\n`,
  }

  it('con allPaths, un import hacia un archivo fuera de la muestra NO es fantasma', () => {
    // el caso real: top-N por riesgo leyó page.tsx pero no saludo.ts (que existe)
    const res = scanRepo([pkg, tsconfig, page], {
      allPaths: ['app/page.tsx', 'src/lib/saludo.ts', 'package.json', 'tsconfig.json'],
    })
    expect(res.findings.filter((f) => f.title.startsWith('Import fantasma'))).toEqual([])
    expect(res.checks.missingDeps).toEqual([])
  })

  it('sin allPaths el archivo ausente sí se marca como fantasma', () => {
    const res = scanRepo([pkg, tsconfig, page])
    expect(res.findings.some((f) => f.title.startsWith('Import fantasma'))).toBe(true)
  })

  it('partialTree suprime deps sin uso y huérfanos: la muestra no alcanza para afirmarlo', () => {
    const pkgDead = {
      path: 'package.json',
      content: JSON.stringify({ name: 'x', dependencies: { leftpad: '1' } }),
    }
    const res = scanRepo(
      [pkgDead, tsconfig, page, { path: 'src/solo.ts', content: 'export const s = 1\n' }],
      { partialTree: true },
    )
    expect(res.findings.some((f) => f.title.includes('sin uso'))).toBe(false)
    expect(res.findings.some((f) => f.title.includes('huérfano'))).toBe(false)
    // los checks conservan lo observado en la muestra (el panel lo informa como conteo)
    expect(res.checks.unusedDeps).toContain('leftpad')
    expect(res.checks.orphanFiles).toContain('src/solo.ts')
  })

  it('un archivo solo-ruta (sin contenido) no compite como huérfano ni rompe stats', () => {
    const res = scanRepo(
      [pkg, { path: 'src/leido.ts', content: 'export const l = 1\n' }, { path: 'src/solo-ruta.ts', content: '' }],
      {},
    )
    expect(res.checks.orphanFiles).toEqual(['src/leido.ts'])
    expect(res.stats.totalLines).toBe(3) // pkg (1) + leido.ts (2 con su \n final); solo-ruta no suma
  })
})

describe('scanRepo · patrones de credenciales sin falsos positivos', () => {
  it('autoComplete de formularios (new-password / current-password) no es credencial', () => {
    const res = scanRepo([
      {
        path: 'src/app/login/page.tsx',
        content: `<Input autoComplete={needsBootstrap ? 'new-password' : 'current-password'} />\n`,
      },
    ])
    expect(res.findings.filter((f) => f.category === 'security')).toEqual([])
    expect(res.checks.secretCount).toBe(0)
  })

  it('una password hardcodeada real sigue detectándose', () => {
    const res = scanRepo([
      { path: 'src/config.ts', content: `const password = "supersecreto123456"\n` },
      { path: 'src/otro.ts', content: `MY_SECRET='abcdefgh1234567890'\n` },
    ])
    expect(res.checks.secretCount).toBe(2)
  })
})

describe('scanRepo · dependencias sin uso (incluye scope @org/pkg)', () => {
  it('una dependencia con scope declarada y nunca importada se marca', () => {
    const res = scanRepo([
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'x', dependencies: { '@dnd-kit/core': '^6', clsx: '^2' } }),
      },
      { path: 'src/a.ts', content: `import { clsx } from 'clsx'\nexport const a = clsx\n` },
    ])
    const unused = res.findings.find((f) => f.title.includes('sin uso'))
    expect(unused?.explanation).toContain('@dnd-kit/core')
    expect(unused?.explanation).not.toContain('clsx')
  })

  it('una dependencia mencionada por nombre en un config no se marca (carga por string)', () => {
    const res = scanRepo([
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'x', dependencies: { 'algun-plugin': '1' } }),
      },
      { path: 'vite.config.ts', content: `export default { plugins: ['algun-plugin'] }\n` },
    ])
    expect(res.findings.some((f) => f.title.includes('sin uso'))).toBe(false)
    // el check la observa, pero el hallazgo no la afirma
    expect(res.checks.unusedDeps).toContain('algun-plugin')
  })
})

describe('selectAuditFiles', () => {
  const manifest: RepoFile = {
    path: 'package.json',
    content: JSON.stringify({ name: 'x', dependencies: { a: '1' } }),
  }

  it('incluye el manifiesto, no duplica archivos y respeta el techo de lotes', () => {
    const files: RepoFile[] = [manifest]
    for (let i = 0; i < 60; i++) {
      files.push({ path: `src/m${i}.ts`, content: `export const m${i} = ${i}\n` })
    }
    const sel = selectAuditFiles(files, 'package.json')
    const flat = sel.batches.flat()
    expect(sel.batches.length).toBeLessThanOrEqual(3)
    expect(new Set(flat.map((f) => f.path)).size).toBe(flat.length)
    expect(sel.auditedPaths).toContain('package.json')
    expect(sel.truncated).toBe(true) // 61 archivos no caben en 3 lotes
  })

  it('excluye archivos más grandes que el presupuesto de lote', () => {
    const huge: RepoFile = { path: 'src/huge.ts', content: 'x'.repeat(20_000) }
    const sel = selectAuditFiles([manifest, huge], 'package.json')
    expect(sel.auditedPaths).toContain('package.json')
    expect(sel.auditedPaths).not.toContain('src/huge.ts')
    expect(sel.truncated).toBe(true)
  })
})

describe('scoring determinista', () => {
  it('score 100 sin hallazgos y penaliza según severidad', () => {
    expect(scoreFromFindings([])).toBe(100)
    expect(scoreFromFindings([{ severity: 'critical', title: 'x', lines: [1], explanation: '', fix: '' }])).toBe(75)
    // 25 (critical) + 15 (high) + 8 (medium) = 48 de penalización
    expect(
      scoreFromFindings([
        { severity: 'critical', title: 'a', lines: [1], explanation: '', fix: '' },
        { severity: 'high', title: 'b', lines: [1], explanation: '', fix: '' },
        { severity: 'medium', title: 'c', lines: [1], explanation: '', fix: '' },
      ]),
    ).toBe(52)
  })

  it('veredictos en los umbrales correctos', () => {
    expect(verdictFromScore(100)).toBe('SHIP IT')
    expect(verdictFromScore(80)).toBe('SHIP IT')
    expect(verdictFromScore(79)).toBe('CASI LISTO')
    expect(verdictFromScore(60)).toBe('CASI LISTO')
    expect(verdictFromScore(59)).toBe('SOSPECHOSO')
    expect(verdictFromScore(40)).toBe('SOSPECHOSO')
    expect(verdictFromScore(39)).toBe('PELIGRO')
    expect(verdictFromScore(0)).toBe('PELIGRO')
  })
})
