import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  buildTarBuffer,
  gunzipStream,
  iterTarEntries,
  readTarTree,
  stripTarRoot,
  TopRiskKeeper,
} from '../src/lib/tar-gz'

const asGzStream = (tar: Buffer): ReadableStream<Uint8Array> =>
  new Response(gzipSync(tar)).body as ReadableStream<Uint8Array>

const asRawStream = (buf: Buffer): AsyncIterable<Buffer> => Readable.from([buf])

const ROOT = 'owner-repo-main'

/** read() solo es válido dentro de la iteración: capturamos contenido al vuelo */
async function collect(stream: AsyncIterable<Buffer>, maxBytes = 1024) {
  const out: { path: string; size: number; content: string }[] = []
  for await (const e of iterTarEntries(stream)) {
    out.push({ path: e.path, size: e.size, content: await e.read(maxBytes) })
  }
  return out
}

describe('iterTarEntries', () => {
  it('parsea archivos, salta directorios y termina en los bloques cero', async () => {
    const tar = buildTarBuffer([
      { path: `${ROOT}`, kind: 'dir' },
      { path: `${ROOT}/README.md`, content: '# hola\n' },
      { path: `${ROOT}/src`, kind: 'dir' },
      { path: `${ROOT}/src/index.ts`, content: 'export const x = 1\n' },
      { path: `${ROOT}/fin`, kind: 'dir' },
    ])
    const entries = await collect(asRawStream(tar))
    expect(entries.map((e) => e.path)).toEqual([`${ROOT}/README.md`, `${ROOT}/src/index.ts`])
    expect(entries[0]!.content).toBe('# hola\n')
  })

  it('resuelve paths largos vía prefix ustar (>100 caracteres)', async () => {
    const prefix = 'muy/larga/ruta/' + 'a/'.repeat(40) // >100 con el nombre
    const tar = buildTarBuffer([{ path: 'archivo.ts', content: 'ok\n', prefix }])
    const entries = await collect(asRawStream(tar))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe(`${prefix}/archivo.ts`)
    expect(entries[0]!.content).toBe('ok\n')
  })

  it('resuelve paths largos vía header pax (x) — lo que emiten los tarballs de GitHub', async () => {
    const longPath = `${ROOT}/src/' + 'profundo/'.repeat(20) + 'hoja.ts`
    const tar = buildTarBuffer([{ path: longPath, content: 'export {}\n', kind: 'pax' }])
    const entries = await collect(asRawStream(tar))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe(longPath)
  })

  it('resuelve GNU longname (L)', async () => {
    const longPath = `${ROOT}/${'l/'.repeat(60)}x.ts`
    const tar = buildTarBuffer([{ path: longPath, content: 'x\n', kind: 'longname' }])
    const entries = await collect(asRawStream(tar))
    expect(entries[0]!.path).toBe(longPath)
  })

  it('descarta el contenido de las entradas que nadie leyó sin corromper el flujo', async () => {
    const tar = buildTarBuffer([
      { path: `${ROOT}/a.ts`, content: 'primero\n' },
      { path: `${ROOT}/b.ts`, content: 'segundo\n' },
    ])
    const paths: string[] = []
    for await (const e of iterTarEntries(asRawStream(tar))) {
      paths.push(e.path) // sin llamar a read()
    }
    expect(paths).toEqual([`${ROOT}/a.ts`, `${ROOT}/b.ts`])
  })
})

describe('stripTarRoot', () => {
  it('quita la carpeta raíz de codeload y normaliza', () => {
    expect(stripTarRoot('owner-repo-main/src/index.ts')).toBe('src/index.ts')
    expect(stripTarRoot('./owner-repo-main/src/a.ts')).toBe('src/a.ts')
    expect(stripTarRoot('owner-repo-main')).toBeNull() // la raíz misma
    expect(stripTarRoot('sin-raiz.ts')).toBeNull()
  })
})

describe('TopRiskKeeper', () => {
  it('retiene el top-N por riesgo y cuenta las evicciones', async () => {
    const keeper = new TopRiskKeeper(2, 1024)
    const fakeRead = (content: string) => async () => content
    await keeper.consider('docs/README.md', fakeRead('a'))
    await keeper.consider('src/utils/helpers.ts', fakeRead('b'))
    await keeper.consider('src/auth/login.ts', fakeRead('c')) // riesgo alto: entra y expulsa al más bajo
    await keeper.consider('docs/otro.md', fakeRead('d')) // riesgo bajo: ni se lee
    expect(keeper.paths).toContain('src/auth/login.ts')
    expect(keeper.paths).toHaveLength(2)
    expect(keeper.truncated).toBe(true)
  })

  it('los archivos estructurales (package.json, tsconfig.json) nunca se evictan', async () => {
    const keeper = new TopRiskKeeper(2, 1024)
    const fakeRead = (content: string) => async () => content
    await keeper.consider('src/auth/a.ts', fakeRead('a'))
    await keeper.consider('src/api/b.ts', fakeRead('b'))
    await keeper.consider('src/api/c.ts', fakeRead('c')) // llena el cupo de riesgo alto
    await keeper.consider('tsconfig.json', fakeRead('{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}'))
    await keeper.consider('package.json', fakeRead('{"name":"x"}'))
    // anidados también: en monorepos cada paquete declara sus propias deps
    await keeper.consider('packages/api-client/package.json', fakeRead('{"name":"@x/api-client"}'))
    await keeper.consider('apps/desktop/tsconfig.json', fakeRead('{"compilerOptions":{}}'))
    await keeper.consider('node_modules/react/package.json', fakeRead('{"name":"react"}')) // pesado: jamás
    expect(keeper.paths).toContain('tsconfig.json')
    expect(keeper.paths).toContain('package.json')
    expect(keeper.paths).toContain('packages/api-client/package.json')
    expect(keeper.paths).toContain('apps/desktop/tsconfig.json')
    expect(keeper.paths).not.toContain('node_modules/react/package.json')
    expect(keeper.files.find((f) => f.path === 'packages/api-client/package.json')?.content).toContain('@x/api-client')
    // los estructurales no consumen cupo del top-N
    expect(keeper.paths.filter((p) => p.startsWith('src/'))).toHaveLength(2)
  })
})

describe('readTarTree', () => {
  it('cuenta el árbol completo y retiene el top-N por riesgo, con gzip real', async () => {
    const tar = buildTarBuffer([
      { path: `${ROOT}`, kind: 'dir' },
      { path: `${ROOT}/docs/a.md`, content: 'md\n' },
      { path: `${ROOT}/docs/b.md`, content: 'md\n' },
      { path: `${ROOT}/docs/c.md`, content: 'md\n' },
      { path: `${ROOT}/src/auth/login.ts`, content: 'export const login = 1\n' },
      { path: `${ROOT}/logo.png`, content: 'binario-que-no-cuenta' },
    ])
    const tree = await readTarTree(asGzStream(tar), { maxFiles: 2 })
    expect(tree.treeCount).toBe(4) // los .md + login (el .png no es escaneable)
    expect(tree.files.map((f) => f.path)).toContain('src/auth/login.ts')
    expect(tree.truncated).toBe(true)
    // contenido truncado al cap por archivo
    expect(tree.files.find((f) => f.path === 'src/auth/login.ts')?.content).toBe('export const login = 1\n')
  })

  it('sin excedente no marca truncado', async () => {
    const tar = buildTarBuffer([{ path: `${ROOT}/a.ts`, content: 'export const a = 1\n' }])
    const tree = await readTarTree(asGzStream(tar), { maxFiles: 5 })
    expect(tree.treeCount).toBe(1)
    expect(tree.truncated).toBe(false)
    expect(tree.files).toHaveLength(1)
  })

  it('monorepo: los package.json anidados viajan con contenido aunque el cap los patearía', async () => {
    // escenario dev_deck: 712 archivos, cap 120 — sin esta garantía la unión de
    // workspaces se queda sin datos y cada import npm sale como dependencia fantasma
    const entries = [
      { path: `${ROOT}/package.json`, content: '{"name":"raiz","devDependencies":{"eslint":"^9"}}' },
      { path: `${ROOT}/apps/desktop/package.json`, content: '{"name":"@x/desktop","dependencies":{"react":"^19"}}' },
      { path: `${ROOT}/packages/api-client/package.json`, content: '{"name":"@x/api-client","dependencies":{"uuid":"^9"}}' },
      { path: `${ROOT}/packages/ui/tsconfig.json`, content: '{"compilerOptions":{"strict":true}}' },
    ]
    for (let i = 0; i < 10; i++) {
      entries.push({ path: `${ROOT}/src/auth/modulo${i}.ts`, content: `export const m${i} = 1\n` })
    }
    const tar = buildTarBuffer(entries)
    const tree = await readTarTree(asGzStream(tar), { maxFiles: 3 })
    expect(tree.truncated).toBe(true)
    const paths = tree.files.map((f) => f.path)
    // los 4 manifiestos/configs sobreviven con contenido pese al cap…
    for (const e of entries.slice(0, 4)) {
      const rel = e.path.slice(ROOT.length + 1)
      expect(paths).toContain(rel)
      expect(tree.files.find((f) => f.path === rel)?.content).toBe(e.content)
    }
    // …y no consumen cupo: los 3 slots de riesgo quedan para el código fuente
    expect(paths.filter((p) => p.startsWith('src/auth/'))).toHaveLength(3)
  })

  it('allPaths registra el árbol escaneable completo, incluido lo evictado por el cap', async () => {
    const tar = buildTarBuffer([
      { path: `${ROOT}/docs/a.md`, content: 'md\n' },
      { path: `${ROOT}/docs/b.md`, content: 'md\n' },
      { path: `${ROOT}/src/lib/saludo.ts`, content: 'export const hola = 1\n' },
      { path: `${ROOT}/tsconfig.json`, content: '{"compilerOptions":{}}' },
    ])
    const tree = await readTarTree(asGzStream(tar), { maxFiles: 1 })
    expect(tree.allPaths).toEqual(['docs/a.md', 'docs/b.md', 'src/lib/saludo.ts', 'tsconfig.json'])
    // tsconfig viaja con contenido aunque el cap sea 1
    expect(tree.files.map((f) => f.path)).toEqual(['tsconfig.json', expect.any(String)])
    expect(tree.allPaths.length).toBe(tree.treeCount)
  })

  it('aplica el techo de descompresión con mensaje que refleja el cap', async () => {
    const tar = buildTarBuffer([
      { path: `${ROOT}/a.ts`, content: 'x'.repeat(10_000) },
      { path: `${ROOT}/b.ts`, content: 'y'.repeat(10_000) },
    ])
    await expect(
      readTarTree(asGzStream(tar), { maxFiles: 10, maxDecompressedBytes: 512 }),
    ).rejects.toThrow(/512 bytes/)
  })

  it('un tarball truncado produce un error claro', async () => {
    const tar = gzipSync(
      buildTarBuffer([{ path: `${ROOT}/a.ts`, content: 'x'.repeat(5000) }]),
    ).subarray(0, 60)
    await expect(readTarTree(asRawStream(tar), { maxFiles: 10 })).rejects.toThrow(/descomprimir/)
  })

  it('acepta streams web (lo que llega del fetch de GitHub)', async () => {
    const tar = buildTarBuffer([{ path: `${ROOT}/a.ts`, content: 'export const a = 1\n' }])
    const tree = await readTarTree(asGzStream(tar), { maxFiles: 5 })
    expect(tree.files[0]?.path).toBe('a.ts')
  })

  it('gunzipStream sobre un iterador simple también funciona', async () => {
    const tar = gzipSync(Buffer.from('hola'))
    const chunks: Buffer[] = []
    for await (const c of gunzipStream(asRawStream(tar))) chunks.push(c)
    expect(Buffer.concat(chunks).toString()).toBe('hola')
  })
})
