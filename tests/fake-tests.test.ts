import { describe, expect, it } from 'vitest'
import { detectFakeTests, isTestFile } from '../src/lib/fake-tests'
import { scanRepo } from '../src/lib/repo-scan'
import type { RepoFile } from '../src/lib/repo-types'

const file = (path: string, content: string): RepoFile => ({ path, content })

describe('detectFakeTests · JS/TS', () => {
  it('detecta la tautología clásica expect(true).toBe(true)', () => {
    const { findings, suspiciousFiles } = detectFakeTests([
      file('src/a.test.ts', `import { expect, it } from 'vitest'\nit('x', () => {\n  expect(true).toBe(true)\n})\n`),
    ])
    const f = findings.find((x) => x.title.includes('tautológicas'))
    expect(f).toBeDefined()
    expect(f?.severity).toBe('medium')
    expect(f?.category).toBe('bugs')
    expect(f?.lines).toContain(3)
    expect(suspiciousFiles).toEqual(['src/a.test.ts'])
  })

  it('detecta tautologías de identificador y de truthy', () => {
    const { findings } = detectFakeTests([
      file(
        'src/b.test.ts',
        `it('a', () => {\n  expect(result).toBe(result)\n  expect('valor').toBeTruthy()\n})\n`,
      ),
    ])
    expect(findings.some((x) => x.title.includes('tautológicas'))).toBe(true)
  })

  it('NO marca assertions legítimas (identificador vs literal, mocks con expect)', () => {
    const { findings } = detectFakeTests([
      file(
        'src/ok.test.ts',
        `import { expect, it, vi } from 'vitest'\nit('guarda el usuario', () => {\n  const save = vi.fn()\n  save({ id: 1 })\n  expect(save).toHaveBeenCalledWith({ id: 1 })\n  expect(user.id).toBe(42)\n  expect(items).toHaveLength(2)\n})\n`,
      ),
    ])
    expect(findings).toEqual([])
  })

  it('detecta la suite que no puede fallar (tests sin ni un assert)', () => {
    const { findings } = detectFakeTests([
      file(
        'src/vacio.test.ts',
        `import { it } from 'vitest'\nit('corre algo', () => {\n  console.log('hola')\n})\nit('espera', async () => {\n  await Promise.resolve()\n})\n`,
      ),
    ])
    const f = findings.find((x) => x.title.includes('no puede fallar'))
    expect(f?.severity).toBe('high')
    expect(f?.category).toBe('bugs')
  })

  it('no marca como "no puede fallar" un archivo sin declaraciones de test', () => {
    const { findings } = detectFakeTests([
      file('src/helpers.ts', `export const suma = (a: number, b: number) => a + b\n`),
      file('src/__tests__/setup.ts', `export const setup = () => ({ db: true })\n`),
    ])
    expect(findings).toEqual([])
  })

  it('detecta cuerpos vacíos y tests saltados', () => {
    const { findings } = detectFakeTests([
      file(
        'src/c.test.ts',
        `it('pendiente', () => {})\nit('skipme', () => {})\nit.skip('tarde', () => {\n  expect(1).toBe(2)\n})\n`,
      ),
    ])
    expect(findings.some((x) => x.title.includes('cuerpo vacío'))).toBe(true)
    expect(findings.some((x) => x.title.includes('saltados'))).toBe(true)
  })

  it('agrupa por archivo: un hallazgo por tipo de defecto', () => {
    const { findings } = detectFakeTests([
      file(
        'src/d.test.ts',
        `it('a', () => {\n  expect(true).toBe(true)\n  expect(1).toBe(1)\n})\n`,
      ),
    ])
    expect(findings.filter((x) => x.title.includes('tautológicas'))).toHaveLength(1)
    expect(findings[0]?.lines?.length).toBeGreaterThan(1)
  })
})

describe('detectFakeTests · Python', () => {
  it('detecta test_*.py sin asserts, y el assert True como tautología', () => {
    const { findings } = detectFakeTests([
      file('tests/test_auth.py', `def test_login():\n    print("hola")\n\ndef test_logout():\n    sesion = cerrar()\n`),
      file('tests/test_lazy.py', `def test_todo_ok():\n    assert True\n`),
    ])
    expect(findings.some((x) => x.file === 'tests/test_auth.py' && x.title.includes('no puede fallar'))).toBe(true)
    expect(findings.some((x) => x.file === 'tests/test_lazy.py' && x.title.includes('tautológicas'))).toBe(true)
  })

  it('no marca pytest con asserts reales', () => {
    const { findings } = detectFakeTests([
      file('tests/test_calc.py', `import pytest\n\ndef test_suma():\n    assert suma(1, 2) == 3\n\ndef test_falla():\n    with pytest.raises(ValueError):\n        romper()\n`),
    ])
    expect(findings).toEqual([])
  })
})

describe('isTestFile', () => {
  it('reconoce las convenciones comunes sin falsos positivos', () => {
    expect(isTestFile('src/login.test.ts')).toBe(true)
    expect(isTestFile('src/login.spec.jsx')).toBe(true)
    expect(isTestFile('src/__tests__/login.ts')).toBe(true)
    expect(isTestFile('tests/test_login.py')).toBe(true)
    expect(isTestFile('src/login_test.py')).toBe(true)
    expect(isTestFile('src/login.ts')).toBe(false)
    expect(isTestFile('src/testdata.json')).toBe(false)
    expect(isTestFile('src/container.spec.d.ts')).toBe(false)
  })
})

describe('integración con scanRepo', () => {
  it('los tests falsos llegan al escaneo completo y a checks.suspiciousTestFiles', () => {
    const res = scanRepo([
      { path: 'package.json', content: JSON.stringify({ name: 'x', devDependencies: { vitest: '2' } }) },
      file('src/mod.ts', `export const mod = 1\n`),
      file('src/mod.test.ts', `import { mod } from './mod'\nit('x', () => {\n  expect(true).toBe(true)\n})\n`),
    ])
    expect(res.checks.suspiciousTestFiles).toContain('src/mod.test.ts')
    expect(res.findings.some((f) => f.title.includes('tautológicas') && f.file === 'src/mod.test.ts')).toBe(true)
    // el test importa ./mod: no se vuelve huérfano ni fantasma
    expect(res.checks.orphanFiles).not.toContain('src/mod.ts')
    expect(res.checks.missingDeps).toEqual([])
  })
})
