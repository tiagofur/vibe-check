// ─────────────────────────────────────────────────────────────
// VibeCheck · Selección de archivos de carpetas locales
// Constantes y decisiones compartidas por el cliente (que filtra
// ANTES de leer) y el servidor (que valida el payload). Puro: sin
// APIs de navegador ni de Node, testeable.
// ─────────────────────────────────────────────────────────────

export const FOLDER_CAPS = {
  /** máximo de archivos que se suben para auditar */
  maxFiles: 800,
  /** presupuesto total de contenido subido (tamaño del texto utf8) */
  maxTotalBytes: 8_000_000,
  /** tamaño máximo de archivo elegible — igual que isScannablePath */
  maxFileBytes: 256 * 1024,
  /** recorte de contenido al leer (los imports viven arriba del archivo) */
  readCap: 64 * 1024,
  /** tope de candidatos en drag&drop: protección contra árboles enormes */
  maxCandidates: 20_000,
} as const

/** Directorios que nunca se recorren en drag&drop ni se suben */
export const HEAVY_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next',
  'vendor', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode',
  'bin', 'obj', '.turbo', '.cache',
])

export const RE_HEAVY_PATH =
  /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|vendor|__pycache__|\.venv|venv|target|bin|obj|\.turbo|\.cache)(\/|$)/

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'mp4', 'mp3', 'wav', 'mov',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'exe', 'dll', 'so', 'dylib',
  'class', 'jar', 'pyc', 'wasm', 'map', 'db', 'sqlite', 'lock',
])

export function extOf(path: string): string {
  const base = path.split('/').pop() ?? path
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx + 1).toLowerCase()
}

/** ¿Cae dentro de un directorio pesado (node_modules, .git…)? */
export function inHeavyPath(path: string): boolean {
  return RE_HEAVY_PATH.test(path)
}

export type OmitReason = 'heavy-dir' | 'binary' | 'too-big' | 'no-ext' | 'overflow-files' | 'overflow-bytes'

/**
 * Decide si un archivo de carpeta es elegible. El contenido no se
 * evalúa aquí: el caller aplica los caps de archivos/bytes totales.
 */
export function pickDecision(path: string, size: number): 'ok' | OmitReason {
  if (inHeavyPath(path)) return 'heavy-dir'
  if (size > FOLDER_CAPS.maxFileBytes) return 'too-big'
  const ext = extOf(path)
  if (!ext) return 'no-ext'
  if (BINARY_EXT.has(ext)) return 'binary'
  return 'ok'
}

/** Resumen legible de omitidos para el toast de la UI */
export function omittedSummary(omitted: Partial<Record<OmitReason, number>>): string {
  const heavy =
    (omitted['heavy-dir'] ?? 0) +
    (omitted['binary'] ?? 0) +
    (omitted['too-big'] ?? 0) +
    (omitted['no-ext'] ?? 0)
  const parts: string[] = []
  if (heavy > 0) parts.push(`${heavy} no elegibles`)
  if ((omitted['overflow-files'] ?? 0) > 0) parts.push(`${omitted['overflow-files']} por tope de archivos`)
  if ((omitted['overflow-bytes'] ?? 0) > 0) parts.push(`${omitted['overflow-bytes']} por tope de tamaño`)
  return parts.join(' · ')
}
