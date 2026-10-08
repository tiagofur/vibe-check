// ─────────────────────────────────────────────────────────────
// VibeCheck · Lectura streaming de tarballs (codeload)
// Parser tar incremental, cero dependencias: procesa entradas de
// una en una sin cargar el tarball en memoria. Cualquier repo
// funciona: el contenido se guarda solo del top-N por riesgo y el
// resto del stream se descarta sobre la marcha.
// ─────────────────────────────────────────────────────────────

import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import type { RepoFile } from './repo-types'
import { isScannablePath, riskScore } from './repo-scan'
import { isStructuralFile } from './folder-pick'

export const MAX_DECOMPRESSED_BYTES = 1.5 * 1024 * 1024 * 1024

const BLOCK = 512
const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024 * 1024))} GB`
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

// ── Bloques de 512 bytes sobre un iterador descomprimido ───

class BlockReader {
  private queue: Buffer[] = []
  private queued = 0
  private done = false
  bytes = 0

  constructor(
    private readonly iterator: AsyncIterator<Buffer>,
    private readonly maxBytes: number,
  ) {}

  /** Garantiza n bytes en cola; false si el stream terminó antes */
  async need(n: number): Promise<boolean> {
    while (this.queued < n) {
      const { value, done } = await this.iterator.next()
      if (done) {
        this.done = true
        break
      }
      this.bytes += value.length
      if (this.bytes > this.maxBytes) {
        throw new Error(
          `El repositorio descomprime más de ${formatBytes(this.maxBytes)}: demasiado incluso para una lectura parcial.`,
        )
      }
      this.queue.push(value)
      this.queued += value.length
    }
    return this.queued >= n
  }

  async take(n: number): Promise<Buffer> {
    if (!(await this.need(n))) throw new Error('El tarball está truncado o corrupto.')
    const flat = this.queue.length === 1 ? this.queue[0]! : Buffer.concat(this.queue, this.queued)
    const out = flat.subarray(0, n)
    const rest = flat.subarray(n)
    this.queue = rest.length > 0 ? [Buffer.from(rest)] : []
    this.queued = rest.length
    return out
  }

  async discard(n: number): Promise<void> {
    let left = n
    while (left > 0) {
      if (this.queued === 0) {
        const want = Math.min(left, 512 * 1024)
        if (!(await this.need(want))) throw new Error('El tarball está truncado o corrupto.')
      }
      const head = this.queue[0]!
      const use = Math.min(head.length, left)
      if (use === head.length) {
        this.queue.shift()
      } else {
        this.queue[0] = Buffer.from(head.subarray(use))
      }
      this.queued -= use
      left -= use
    }
  }
}

export interface TarEntry {
  path: string
  size: number
  /** Lee hasta maxBytes del contenido (utf8). Debe llamarse antes de pedir la siguiente entrada */
  read(maxBytes: number): Promise<string>
}

function cstr(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const nul = field.indexOf(0)
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8').trim()
}

function octal(buf: Buffer, start: number, length: number): number {
  const raw = buf.subarray(start, start + length).toString('ascii').replace(/[\0 ]+$/g, '').trim()
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Registros pax: "25 path=src/largo.txt\n" repetidos */
function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < data.length) {
    const sp = data.indexOf(32, i)
    if (sp === -1) break
    const len = Number.parseInt(data.subarray(i, sp).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = data.subarray(sp + 1, i + len).toString('utf8').replace(/\n$/, '')
    const eq = record.indexOf('=')
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += len
  }
  return out
}

/**
 * Itera las entradas de un stream ya descomprimido de tar.
 * Soporta ustar (name+prefix), pax ('x'), GNU longname ('L') y
 * pax global ('g'); los directorios no se entregan.
 */
export async function* iterTarEntries(
  decompressed: AsyncIterable<Buffer>,
  opts?: { maxDecompressedBytes?: number },
): AsyncGenerator<TarEntry> {
  const reader = new BlockReader(
    decompressed[Symbol.asyncIterator](),
    opts?.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES,
  )
  let pendingPath: string | null = null

  while (true) {
    if (!(await reader.need(BLOCK))) break
    const header = await reader.take(BLOCK)
    if (header.every((b) => b === 0)) break // fin del tar (bloques cero)

    let name = cstr(header, 0, 100)
    const size = octal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 48)
    const prefix = cstr(header, 345, 155)
    const dataLen = padded(size)

    if (typeflag === 'x') {
      pendingPath = parsePax(await reader.take(dataLen))['path'] ?? null
      continue
    }
    if (typeflag === 'L') {
      pendingPath = cstr(await reader.take(dataLen), 0, dataLen)
      continue
    }
    if (typeflag === 'g') {
      await reader.discard(dataLen) // pax global: se ignora
      continue
    }

    if (pendingPath) {
      name = pendingPath
      pendingPath = null
    } else if (prefix) {
      name = `${prefix}/${name}`
    }

    if (typeflag === '5') {
      await reader.discard(dataLen) // directorio
      continue
    }

    let consumed = false
    yield {
      path: name,
      size,
      read: async (maxBytes: number): Promise<string> => {
        consumed = true
        const data = await reader.take(dataLen)
        return data.subarray(0, Math.min(size, maxBytes)).toString('utf8')
      },
    }
    if (!consumed) await reader.discard(dataLen)
  }
}

/** Gunzip incremental; el techo de bytes lo aplica BlockReader sobre lo descomprimido */
export async function* gunzipStream(
  source: ReadableStream<Uint8Array> | AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  const gunzip = createGunzip()
  const nodeSource =
    Symbol.asyncIterator in (source as object)
      ? Readable.from(source as AsyncIterable<Buffer>)
      : Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0])
  const piped = nodeSource.pipe(gunzip)
  piped.on('error', () => {})
  try {
    for await (const chunk of piped) {
      yield chunk as Buffer
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`El tarball no se pudo descomprimir (¿truncado o corrupto?): ${message}`)
  } finally {
    gunzip.destroy()
    nodeSource.destroy()
  }
}

// ── Árbol top-N por riesgo, en un solo pase ────────────────

export interface TreeReadResult {
  /** Archivos escaneables retenidos (top-N por riesgo) */
  files: RepoFile[]
  /** Total de archivos escaneables vistos en el tar completo */
  treeCount: number
  /** Rutas del top-N retenido, en orden de riesgo */
  treePreview: string[]
  /** Rutas de TODO el árbol escaneable (para resolver imports fuera de la muestra) */
  allPaths: string[]
  /** true si hubo entradas elegibles descartadas por el cap */
  truncated: boolean
  decompressedBytes: number
}

/** Quita la carpeta raíz del tarball de codeload (owner-repo-ref/) y normaliza */
export function stripTarRoot(path: string): string | null {
  const clean = path.replace(/^\.\//, '').replace(/^\/+/, '')
  const slash = clean.indexOf('/')
  if (slash === -1) return null // la propia carpeta raíz
  return clean.slice(slash + 1)
}

/** Techo defensivo del registro de rutas: árboles absurdos degradan a muestra */
const MAX_ALL_PATHS = 50_000

/** Reserva contenido del top-N por riskScore; descarta sin leer lo que no cabe */
export class TopRiskKeeper {
  private kept: { path: string; risk: number; content: string }[] = []
  /** manifiestos y tsconfig: el grafo los exige, nunca se evictan */
  private structural = new Map<string, string>()
  evictions = 0

  constructor(
    readonly max: number,
    readonly maxBytesPerFile: number,
  ) {}

  get truncated(): boolean {
    return this.evictions > 0
  }

  private get lowestRisk(): number {
    return this.kept[this.kept.length - 1]?.risk ?? Number.NEGATIVE_INFINITY
  }

  async consider(path: string, read: (maxBytes: number) => Promise<string>): Promise<void> {
    if (isStructuralFile(path)) {
      if (!this.structural.has(path)) this.structural.set(path, await read(this.maxBytesPerFile))
      return
    }
    const risk = riskScore(path)
    if (this.kept.length >= this.max && risk <= this.lowestRisk) {
      this.evictions++
      return
    }
    const content = await read(this.maxBytesPerFile)
    const item = { path, risk, content }
    const idx = this.kept.findIndex((k) => k.risk < risk)
    if (idx === -1) {
      if (this.kept.length < this.max) this.kept.push(item)
      else this.evictions++
    } else {
      this.kept.splice(idx, 0, item)
      if (this.kept.length > this.max) {
        this.kept.pop()
        this.evictions++
      }
    }
  }

  get files(): RepoFile[] {
    const structuralFiles = [...this.structural].map(([path, content]) => ({ path, content }))
    return [...structuralFiles, ...this.kept.map((k) => ({ path: k.path, content: k.content }))]
  }

  get paths(): string[] {
    return [...this.structural.keys(), ...this.kept.map((k) => k.path)]
  }
}

/**
 * Lee un tarball .tar.gz completo en streaming y devuelve el árbol:
 * conteo total real + contenido del top-N de archivos por riesgo.
 */
export async function readTarTree(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Buffer>,
  opts: { maxFiles: number; maxBytesPerFile?: number; maxDecompressedBytes?: number },
): Promise<TreeReadResult> {
  const keeper = new TopRiskKeeper(opts.maxFiles, opts.maxBytesPerFile ?? 64 * 1024)
  let treeCount = 0
  const allPaths: string[] = []

  const entries = iterTarEntries(gunzipStream(stream), {
    maxDecompressedBytes: opts.maxDecompressedBytes,
  })
  for await (const entry of entries) {
    const rel = stripTarRoot(entry.path)
    if (!rel || rel.includes('..')) continue
    if (!isScannablePath(rel, entry.size)) continue
    treeCount++
    if (allPaths.length < MAX_ALL_PATHS) allPaths.push(rel)
    await keeper.consider(rel, entry.read)
  }

  return {
    files: keeper.files,
    treeCount,
    treePreview: keeper.paths,
    allPaths,
    truncated: keeper.truncated,
    decompressedBytes: 0,
  }
}

// ── Constructor de tars para tests ─────────────────────────

function tarHeaderBytes(path: string, size: number, typeflag: string, prefixPath?: string): Buffer {
  const block = Buffer.alloc(BLOCK, 0)
  block.write(path.slice(0, 100), 0, 100, 'utf8')
  block.write('0000644\0', 100, 8, 'ascii')
  block.write('0000000\0', 108, 8, 'ascii')
  block.write('0000000\0', 116, 8, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii') // checksum provisorio
  block.write(typeflag, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  if (prefixPath) block.write(prefixPath, 345, 155, 'utf8')
  let sum = 0
  for (const b of block) sum += b
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

function dataBlocks(content: string): Buffer {
  const buf = Buffer.from(content, 'utf8')
  return Buffer.concat([buf, Buffer.alloc(padded(buf.length) - buf.length)])
}

function paxEntry(path: string, content: string): Buffer {
  const record = `path=${path}\n`
  let len = record.length + 2
  while (String(len).length + 1 + record.length !== len) {
    len = String(len).length + 1 + record.length
  }
  const payload = Buffer.from(`${len} ${record}`, 'utf8')
  return Buffer.concat([
    tarHeaderBytes('PaxHeader', payload.length, 'x'),
    dataBlocks(payload.toString('utf8')),
    tarHeaderBytes('pax-target', Buffer.byteLength(content), '0'),
    dataBlocks(content),
  ])
}

function longNameEntry(path: string, content: string): Buffer {
  const payload = Buffer.concat([Buffer.from(path, 'utf8'), Buffer.alloc(1)])
  return Buffer.concat([
    tarHeaderBytes('././@LongLink', payload.length, 'L'),
    dataBlocks(payload.toString('latin1')),
    tarHeaderBytes('longname-target', Buffer.byteLength(content), '0'),
    dataBlocks(content),
  ])
}

/** Construye un tar en memoria (para tests) con soporte de pax y GNU longname */
export function buildTarBuffer(
  entries: { path: string; content?: string; kind?: 'file' | 'dir' | 'pax' | 'longname'; prefix?: string }[],
): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const kind = e.kind ?? 'file'
    if (kind === 'pax') {
      parts.push(paxEntry(e.path, e.content ?? ''))
    } else if (kind === 'longname') {
      parts.push(longNameEntry(e.path, e.content ?? ''))
    } else if (kind === 'dir') {
      parts.push(tarHeaderBytes(e.path.replace(/\/$/, ''), 0, '5', e.prefix))
    } else {
      const content = e.content ?? ''
      parts.push(tarHeaderBytes(e.path, Buffer.byteLength(content), '0', e.prefix))
      parts.push(dataBlocks(content))
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}
