import { describe, expect, it } from 'vitest'
import {
  FOLDER_CAPS,
  inHeavyPath,
  omittedSummary,
  pickDecision,
} from '../src/lib/folder-pick'

describe('pickDecision', () => {
  it('rechaza node_modules y directorios pesados por path', () => {
    expect(pickDecision('node_modules/react/index.js', 100)).toBe('heavy-dir')
    expect(pickDecision('mi-app/node_modules/.bin/tsc', 100)).toBe('heavy-dir')
    expect(pickDecision('mi-app/.next/server/app.js', 100)).toBe('heavy-dir')
    expect(pickDecision('mi-app/.git/config', 100)).toBe('heavy-dir')
    expect(pickDecision('src/app.ts', 100)).toBe('ok')
  })

  it('rechaza binarios, sin extensión y archivos demasiado grandes', () => {
    expect(pickDecision('src/logo.png', 100)).toBe('binary')
    expect(pickDecision('src/bundle.min.js.map', 100)).toBe('binary')
    expect(pickDecision('src/README', 100)).toBe('no-ext')
    expect(pickDecision('src/huge.ts', FOLDER_CAPS.maxFileBytes + 1)).toBe('too-big')
    expect(pickDecision('src/big.ts', FOLDER_CAPS.maxFileBytes)).toBe('ok')
  })
})

describe('inHeavyPath', () => {
  it('no marca falsos positivos con nombres similares', () => {
    expect(inHeavyPath('src/nodemoduleish.ts')).toBe(false)
    expect(inHeavyPath('src/distritos.ts')).toBe(false)
    expect(inHeavyPath('build/pipeline.ts')).toBe(true)
  })
})

describe('omittedSummary', () => {
  it('resume los omitidos de forma legible', () => {
    expect(omittedSummary({})).toBe('')
    expect(omittedSummary({ 'heavy-dir': 5000, binary: 12 })).toBe('5012 no elegibles')
    expect(omittedSummary({ 'overflow-files': 3 })).toBe('3 por tope de archivos')
    expect(
      omittedSummary({ 'too-big': 2, 'overflow-files': 3, 'overflow-bytes': 1 }),
    ).toBe('2 no elegibles · 3 por tope de archivos · 1 por tope de tamaño')
  })
})
