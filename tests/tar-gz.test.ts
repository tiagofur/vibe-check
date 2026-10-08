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
