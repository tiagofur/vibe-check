// ─────────────────────────────────────────────────────────────
// VibeCheck · Motor determinista de escaneo de repos
// Grafo de imports, dependencias fantasma, secretos, huérfanos.
// Cero LLM: resultados reproducibles y verificables.
// ─────────────────────────────────────────────────────────────

import type { RepoFile, RepoFinding } from './repo-types'
import type { CategoryKey, Severity } from './vibe-types'
import { detectFakeTests } from './fake-tests'

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next',
  'vendor', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode',
  'bin', 'obj', '.turbo', '.cache',
])

const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock',
])

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'mp4', 'mp3', 'wav', 'mov',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'exe', 'dll', 'so', 'dylib',
  'class', 'jar', 'pyc', 'wasm', 'map', 'db', 'sqlite',
])

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript',
  cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  php: 'PHP', rb: 'Ruby', cs: 'C#', swift: 'Swift', c: 'C', cpp: 'C++', sql: 'SQL',
  sh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', json: 'JSON', html: 'HTML',
  css: 'CSS', scss: 'SCSS', vue: 'Vue', svelte: 'Svelte', graphql: 'GraphQL',
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'module',
  'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8',
  'vm', 'worker_threads', 'zlib', 'test',
])

const JS_IMPORT_RE =
  /(?:import\s+|export\s+)(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g

const PY_IMPORT_RE = /^[ \t]*(?:import\s+([\w.]+)(?:\s+as\s+\w+)?|from\s+([\w.]+)\s+import)/gm

const SECRET_PATTERNS: { re: RegExp; title: string; severity: Severity }[] = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, title: 'Clave privada embebida', severity: 'critical' },
  { re: /AKIA[0-9A-Z]{16}/, title: 'AWS Access Key', severity: 'critical' },
  { re: /sk_live_[A-Za-z0-9]{16,}/, title: 'Stripe live key', severity: 'critical' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, title: 'Token de GitHub', severity: 'high' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, title: 'Token de Slack', severity: 'high' },
  { re: /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^/\s:'"]+:[^@/\s"']{4,}@/, title: 'URL de base de datos con contraseña', severity: 'high' },
  // El lookbehind evita matchear claves dentro de palabras compuestas del HTML,
  // ej. autoComplete='new-password' : 'current-password' (falso positivo clásico)
  { re: /(?<![A-Za-z-])(?:api[_-]?key|apikey|secret|password|passwd|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i, title: 'Credencial hardcodeada', severity: 'high' },
]

/** Credenciales de ejemplo de la documentación oficial: reportarlas es mentir */
const EXAMPLE_CREDENTIALS = new Set([
  'AKIAIOSFODNN7EXAMPLE', // AWS docs
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', // AWS docs (secret key)
  'ghp_16C7e42F292c6912E7710c838347Ae178B4a', // GitHub docs
])
const RE_FAKE_CONTEXT = /\b(fake|falsa|falso|ejemplo|example|dummy|placeholder|demo|de prueba)\b/i
const RE_TEST_PATH =
  /(^|\/)(tests?|specs?|__tests__|fixtures?|mocks?|samples?|examples?|demos?)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.|^test_[^/]*\.|_test\.py$/i

const ENV_EXAMPLE_BASENAMES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults'])

export interface ManifestInfo {
  name: string | null
  deps: Set<string>
  allDeps: Set<string>
  /** nombres de los package.json del workspace (paquetes internos importables) */
  workspaceNames: Set<string>
}

export interface ScanStats {
  totalLines: number
  languages: string[]
  externalUsed: string[]
}

export interface ScanChecks {
  hasManifest: boolean
  manifestName: string | null
  envFiles: string[]
  secretCount: number
  brokenImports: string[]
  missingDeps: string[]
  unusedDeps: string[]
  orphanFiles: string[]
  /** Archivos de test con tautologías, cero asserts, cuerpos vacíos o skips */
  suspiciousTestFiles: string[]
}

export interface ScanResult {
  findings: RepoFinding[]
  stats: ScanStats
  checks: ScanChecks
}

export function extOf(path: string): string {
  const base = path.split('/').pop() ?? path
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx + 1).toLowerCase()
}

export function langLabel(path: string): string | null {
  return EXT_LANG[extOf(path)] ?? null
}

export function isLockFile(path: string): boolean {
  return LOCK_FILES.has(path.split('/').pop() ?? '')
}

/** ¿Este path del árbol vale la pena escanearse? (sin contenido)
 *  El techo de inclusión es alto a propósito: los archivos grandes
 *  (ej. page.tsx de 50KB) aportan imports al grafo aunque su contenido
 *  se trunque al leer (ver walkDir/extractAndRead, 64KB). */
export function isScannablePath(path: string, size: number): boolean {
  if (path.includes('..')) return false
  const segs = path.split('/')
  if (segs.some((s) => SKIP_DIRS.has(s))) return false
  if (isLockFile(path)) return false
  const ext = extOf(path)
  if (!ext || BINARY_EXT.has(ext)) return false
  if (size > 256 * 1024) return false
  return true
}

/** Ranking de riesgo: auth/pagos/db/config primero, tests al final */
export function riskScore(path: string): number {
  const p = path.toLowerCase()
  let score = 0
  const hot: [RegExp, number][] = [
    [/auth|login|session|jwt|token|oauth/, 30],
    [/pay|billing|stripe|checkout|subscription/, 28],
    [/secret|credential|env|password/, 26],
    [/admin|user|account|permission|role/, 18],
    [/sql|db|database|migration|prisma|schema|model/, 16],
    [/api|controller|route|handler|middleware|endpoint/, 14],
    [/webhook|cron|queue|worker/, 12],
    [/config|setting|deploy|docker|ci|pipeline|security/, 10],
    [/(^|\/)(index|main|app|server)\.[a-z]+$/, 12],
    [/test|spec|mock|fixture/, -8],
    [/\.d\.ts$|types?\.ts$/, -4],
  ]
  for (const [re, pts] of hot) if (re.test(p)) score += pts
  return score
}

function isRelative(mod: string): boolean {
  return mod.startsWith('.') || mod.startsWith('/')
}

function isBuiltin(mod: string): boolean {
  const m = mod.startsWith('node:') ? mod.slice(5) : mod
  return NODE_BUILTINS.has(m)
}

function pkgOf(mod: string): string {
  if (mod.startsWith('node:')) return ''
  const segs = mod.split('/')
  return mod.startsWith('@') ? segs.slice(0, 2).join('/') : (segs[0] ?? mod)
}

function normalizeRel(fromFile: string, rel: string): string {
  const fromSegs = fromFile.split('/').slice(0, -1)
  const relSegs = rel.split('/')
  const stack = [...fromSegs]
  for (const seg of relSegs) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.vue', '.svelte', '.css']
const INDEX_BASES = ['/index', '/__index']

// ── Aliases de tsconfig/jsconfig (@/x → src/x) ─────────────

export interface AliasConfig {
  /** baseUrl de tsconfig ('' = raíz del repo) */
  baseUrl: string
  /** prefijos sin el '*' final, ordenados por especificidad */
  prefixes: { prefix: string; target: string; wildcard: boolean }[]
}

const EMPTY_ALIASES: AliasConfig = { baseUrl: '', prefixes: [] }

/** Quita comentarios de JSONC sin tocar strings (el `/*` de "@/…" no es un comentario) */
function stripJsonc(src: string): string {
  let out = ''
  let inStr = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      continue
    }
    out += c
  }
  return out
}

/** Lee compilerOptions.paths; tolera comentarios y trailing commas de tsconfig */
export function parseAliasConfig(file: RepoFile | undefined): AliasConfig {
  if (!file) return EMPTY_ALIASES
  try {
    const json = JSON.parse(stripJsonc(file.content).replace(/,(\s*[}\]])/g, '$1')) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
    }
    const paths = json.compilerOptions?.paths
    if (!paths) return EMPTY_ALIASES
    const baseUrl = (json.compilerOptions?.baseUrl ?? '.').replace(/^\.\//, '').replace(/\/$/, '')
    const prefixes = Object.entries(paths).flatMap(([key, targets]) =>
      (targets ?? []).map((t) => ({
        prefix: key.endsWith('*') ? key.slice(0, -1) : key,
        target: (t ?? '').replace(/\*$/, '').replace(/^\.\//, ''),
        wildcard: key.endsWith('*'),
      })),
    )
    prefixes.sort((a, b) => b.prefix.length - a.prefix.length)
    return { baseUrl, prefixes }
  } catch {
    return EMPTY_ALIASES
  }
}

/** Mapea un import con alias a su ruta real desde la raíz; null si no aplica ninguno */
export function applyAlias(mod: string, aliases: AliasConfig): string | null {
  for (const { prefix, target } of aliases.prefixes) {
    if (mod === prefix) return aliases.baseUrl ? `${aliases.baseUrl}/${target}` : target
  }
  // el match por prefijo solo aplica a patrones con '*': "@lib" no debe capturar "@libfoo"
  for (const { prefix, target, wildcard } of aliases.prefixes) {
    if (wildcard && mod.startsWith(prefix)) {
      const mapped = target + mod.slice(prefix.length)
      return aliases.baseUrl ? `${aliases.baseUrl}/${mapped}` : mapped
    }
  }
  return null
}

/** Imports hacia directorios generados (.next, dist…) no son verificables: no se marcan */
function pointsIntoGenerated(base: string): boolean {
  return base.split('/').some((seg) => SKIP_DIRS.has(seg))
}

function resolves(fromFile: string, rel: string, pathSet: Set<string>): boolean {
  const base = normalizeRel(fromFile, rel)
  for (const ext of RESOLVE_EXTS) {
    if (pathSet.has(base + ext)) return true
  }
  for (const idx of INDEX_BASES) {
    for (const ext of RESOLVE_EXTS.slice(1)) {
      if (pathSet.has(base + idx + ext)) return true
    }
  }
  return false
}

function extractModules(path: string, content: string): string[] {
  const mods: string[] = []
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(path)) {
    for (const m of content.matchAll(JS_IMPORT_RE)) {
      const mod = m[1] ?? m[2] ?? m[3]
      if (mod) mods.push(mod)
    }
  }
  if (path.endsWith('.py')) {
    for (const m of content.matchAll(PY_IMPORT_RE)) {
      const mod = m[1] ?? m[2]
      if (mod) mods.push(mod)
    }
  }
  return [...new Set(mods)]
}

function lineOf(content: string, needle: string): number {
  const idx = content.indexOf(needle)
  if (idx === -1) return 1
  return content.slice(0, idx).split('\n').length
}

function makeFinding(
  file: string,
  severity: Severity,
  category: CategoryKey,
  title: string,
  lines: number[],
  explanation: string,
  fix: string,
): RepoFinding {
  return { file, severity, category, title, lines, explanation, fix, origin: 'scan' }
}

export interface ScanOptions {
  /** Rutas escaneables del árbol completo aunque su contenido no se haya
   *  leído (top-N por riesgo): permite resolver imports fuera de la muestra */
  allPaths?: string[]
  /** El contenido es una muestra del árbol: los hallazgos que exigen el
   *  grafo completo (deps sin uso, huérfanos) se suprimen para no inventar */
  partialTree?: boolean
}

export function scanRepo(files: RepoFile[], opts: ScanOptions = {}): ScanResult {
  const findings: RepoFinding[] = []
  const pathSet = new Set([...(opts.allPaths ?? []), ...files.map((f) => f.path)])
  const pathLower = new Map(files.map((f) => [f.path.toLowerCase(), f.path]))
  const manifestFile =
    files.find((f) => f.path === 'package.json') ??
    files.find((f) => f.path === 'go.mod') ??
    files.find((f) => f.path === 'requirements.txt') ??
    files.find((f) => f.path === 'Cargo.toml') ??
    null

  // ── Manifiesto ──────────────────────────────────────────
  const manifest: ManifestInfo = { name: null, deps: new Set(), allDeps: new Set(), workspaceNames: new Set() }
  let hasManifest = false
  let manifestName: string | null = null
  if (manifestFile && manifestFile.path === 'package.json') {
    hasManifest = true
    manifestName = 'package.json'
    try {
      const pkg = JSON.parse(manifestFile.content) as {
        name?: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      manifest.name = pkg.name ?? null
      for (const d of Object.keys(pkg.dependencies ?? {})) manifest.deps.add(d)
      manifest.allDeps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ])
    } catch {
      findings.push(makeFinding('package.json', 'high', 'bugs', 'package.json inválido', [1], 'El package.json no se puede parsear: el proyecto no instalará ni construirá.', 'Valida el JSON del manifiesto (por ejemplo con `npm pkg get name`).'))
    }
    // Workspaces (pnpm/yarn/npm): cada paquete declara sus propias deps. Solo
    // mirar la raíz inventaría "fantasmas" que no existen — se une el árbol.
    const workspaceNames = new Set<string>()
    for (const f of files) {
      if (!f.path.endsWith('package.json') || f.path === manifestFile.path) continue
      try {
        const pkg = JSON.parse(f.content) as {
          name?: string
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
          peerDependencies?: Record<string, string>
          optionalDependencies?: Record<string, string>
        }
        if (pkg.name) workspaceNames.add(pkg.name)
        for (const d of Object.keys(pkg.dependencies ?? {})) manifest.deps.add(d)
        for (const d of [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
          ...Object.keys(pkg.peerDependencies ?? {}),
          ...Object.keys(pkg.optionalDependencies ?? {}),
        ]) {
          manifest.allDeps.add(d)
        }
      } catch {
        /* package.json de subpaquete ilegible: no bloquea el escaneo */
      }
    }
    manifest.workspaceNames = workspaceNames
  } else if (manifestFile) {
    hasManifest = true
    manifestName = manifestFile.path
  }

  // ── Escaneo por archivo ──────────────────────────────────
  // Aliases de TODOS los tsconfig/jsconfig (raíz y anidados): en monorepos cada
  // paquete define los suyos y sus rutas son relativas a su propio directorio.
  const aliasPrefixes: AliasConfig['prefixes'] = []
  for (const f of files) {
    const base = f.path.split('/').pop() ?? ''
    if (base !== 'tsconfig.json' && base !== 'jsconfig.json') continue
    const cfg = parseAliasConfig(f)
    if (cfg.prefixes.length === 0) continue
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    const baseDir = cfg.baseUrl ? (dir ? `${dir}/${cfg.baseUrl}` : cfg.baseUrl) : dir
    for (const p of cfg.prefixes) {
      aliasPrefixes.push({
        prefix: p.prefix,
        target: baseDir ? `${baseDir}/${p.target}` : p.target,
        wildcard: p.wildcard,
      })
    }
  }
  aliasPrefixes.sort((a, b) => b.prefix.length - a.prefix.length)
  const aliases: AliasConfig = { baseUrl: '', prefixes: aliasPrefixes }
  /** Prueba TODOS los aliases que matchean: gana el primero que resuelve */
  const resolveAliasTarget = (mod: string): string | null => {
    let fallback: string | null = null
    for (const { prefix, target, wildcard } of aliases.prefixes) {
      let mapped: string | null = null
      if (mod === prefix) mapped = target
      else if (wildcard && mod.startsWith(prefix)) mapped = target + mod.slice(prefix.length)
      if (mapped === null) continue
      if (resolves('', mapped, pathSet)) return mapped
      if (fallback === null) fallback = mapped
    }
    return fallback
  }

  const externalUsed = new Set<string>()
  const importedPkgs = new Set<string>()
  const inbound = new Map<string, number>()
  const langCount = new Map<string, number>()
  let totalLines = 0
  const envFiles: string[] = []
  let secretCount = 0
  const missingDepFiles = new Map<string, string[]>()

  /** Verifica un import local (spec = texto original; probe = ruta a resolver;
   *  fromRoot = el probe es raíz-relativo, como los alias de tsconfig) */
  const checkLocalImport = (file: RepoFile, spec: string, probe: string, fromRoot = false): void => {
    const from = fromRoot ? '' : file.path
    if (!resolves(from, probe, pathSet)) {
      if (pointsIntoGenerated(normalizeRel(from, probe))) return
      findings.push(
        makeFinding(
          file.path,
          'high',
          'hallucination',
          'Import fantasma: módulo local inexistente',
          [lineOf(file.content, spec)],
          `El archivo importa "${spec}" pero esa ruta no existe en el repositorio. La IA escribió una llamada a un módulo que nunca creó: el build falla en cuanto se ejecuta.`,
          'Crea el módulo faltante, corrige la ruta del import o elimina la dependencia si no se usa.',
        ),
      )
      return
    }
    const target = normalizeRel(from, probe)
    const resolved =
      RESOLVE_EXTS.map((e) => target + e).find((p) => pathSet.has(p)) ??
      INDEX_BASES.map((i) => RESOLVE_EXTS.slice(1).map((e) => target + i + e)).flat().find((p) => pathSet.has(p))
    if (resolved) inbound.set(resolved, (inbound.get(resolved) ?? 0) + 1)
  }

  for (const f of files) {
    const hasContent = f.content.length > 0
    if (hasContent) totalLines += f.content.split('\n').length
    const lang = langLabel(f.path)
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)

    const base = f.path.split('/').pop() ?? ''
    // .env.example/.sample/.template están hechos para commitearse: no son filtraciones
    const envExample =
      ENV_EXAMPLE_BASENAMES.has(base) ||
      base.endsWith('.example') ||
      base.endsWith('.sample') ||
      base.endsWith('.template')
    if (base.startsWith('.env') && !envExample) {
      envFiles.push(f.path)
    }

    // Secretos (máx 3 matches por archivo para no inundar)
    let fileSecrets = 0
    const contentLines = hasContent ? f.content.split('\n') : []
    for (const { re, title, severity } of SECRET_PATTERNS) {
      const m = hasContent ? f.content.match(re) : null
      if (!m) continue
      if (EXAMPLE_CREDENTIALS.has(m[0])) continue
      if (fileSecrets >= 3) break
      // valores de prueba declarados (contexto "fake/demo" cerca) o archivos de
      // test/fixture: se degradan a low — no pueden clavar el score con un crítico
      let sev = severity
      let note = ''
      const matchIdx = contentLines.findIndex((l) => l.includes(m[0]))
      if (matchIdx !== -1) {
        const ctx = contentLines.slice(Math.max(0, matchIdx - 5), matchIdx + 6).join('\n')
        if (RE_FAKE_CONTEXT.test(ctx)) {
          sev = 'low'
          note = ' El propio archivo lo declara como ejemplo/fake.'
        } else if (RE_TEST_PATH.test(f.path)) {
          sev = 'low'
          note = ' Está en un archivo de test/fixture: no se distingue de un valor de prueba.'
        }
      }
      fileSecrets++
      secretCount++
      findings.push(
        makeFinding(
          f.path,
          sev,
          'security',
          title,
          [matchIdx + 1],
          `Se detectó "${title}" dentro del repositorio. Si el repo es público, la credencial ya debe considerarse comprometida.${note}`,
          'Revoca la credencial inmediatamente, muévela a variables de entorno (.env excluido del repo) y limpia el historial de git si hace falta.',
        ),
      )
    }

    // Imports
    if (!hasContent) continue
    for (const mod of extractModules(f.path, f.content)) {
      const aliasTarget = resolveAliasTarget(mod)
      if (aliasTarget !== null) {
        checkLocalImport(f, mod, aliasTarget, true)
        // resuelto por alias también es "usar" el paquete (workspace:* vía paths):
        // si no, la dep interna aparece como sin uso
        const aliasPkg = pkgOf(mod)
        if (aliasPkg) importedPkgs.add(aliasPkg)
      } else if (isRelative(mod)) {
        if (f.path.endsWith('.py')) continue
        checkLocalImport(f, mod, mod)
      } else if (!isBuiltin(mod)) {
        const pkg = pkgOf(mod)
        if (!pkg) continue
        externalUsed.add(pkg)
        importedPkgs.add(pkg)
        // auto-import del propio paquete y de cualquier paquete del workspace no son fantasmas
        const isSelfRef =
          (manifest.name !== null && pkg === manifest.name) || manifest.workspaceNames.has(pkg)
        if (hasManifest && manifestName === 'package.json' && !isSelfRef && !manifest.allDeps.has(pkg)) {
          const arr = missingDepFiles.get(pkg) ?? []
          arr.push(f.path)
          missingDepFiles.set(pkg, arr)
        }
      }
    }
  }

  // Dependencias fantasma (importadas pero no declaradas)
  for (const [pkg, where] of missingDepFiles) {
    const lineRef = where[0] ?? ''
    const file = where[0] ?? 'package.json'
    const content = files.find((x) => x.path === file)?.content ?? ''
    findings.push(
      makeFinding(
        file,
        'high',
        'hallucination',
        `Dependencia fantasma: "${pkg}" no está en package.json`,
        [lineOf(content, lineRef)],
        `El código importa "${pkg}" en ${where.length > 1 ? `${where.length} archivos (ej. ${where.slice(0, 2).join(', ')})` : where[0]}, pero el paquete no figura en las dependencias. Un \`npm ci\` limpio romperá el build. Es el patrón clásico de código generado por IA que "asume" que el paquete existe.`,
        `Ejecuta \`npm i ${pkg}\` (o elimina el import si no se usa) y verifica que el paquete realmente exista en npm: los LLM a veces alucinan nombres de paquetes (riesgo de slopsquatting).`,
      ),
    )
  }

  // Dependencias muertas (declaradas y nunca importadas). En árbol parcial
  // no se afirma nada: archivos clave pueden estar fuera de la muestra.
  const unusedDeps =
    hasManifest && manifestName === 'package.json'
      ? [...manifest.deps].filter((d) => !importedPkgs.has(d) && !d.startsWith('@types/'))
      : []
  if (unusedDeps.length > 0 && !opts.partialTree) {
    // "mencionada" = su nombre aparece en un config/código pequeño (plugins
    // que se cargan por string, dotfiles): los configs no importan, pero usan.
    // La documentación (md/txt) no cuenta: describir una deps no es usarla.
    const MENTION_EXT = /\.(json|mjs|cjs|ts|tsx|jsx|mts|cts|ya?ml|toml|ini|conf)$/
    const mentionBlob = files
      .filter((f) => {
        if (f.content.length === 0 || f.content.length > 8192) return false
        // los manifiestos nombran a todas sus deps: no prueban uso
        if (f.path === 'package.json' || f.path.endsWith('/package.json')) return false
        const base = f.path.split('/').pop() ?? ''
        return MENTION_EXT.test(f.path) || base.startsWith('.')
      })
      .map((f) => f.content)
      .join('\u0000')
    const dead = unusedDeps.filter((d) => !mentionBlob.includes(d))
    if (dead.length > 0) {
      findings.push(
        makeFinding(
          'package.json',
          'low',
          'overengineering',
          `${dead.length} dependencia(s) sin uso`,
          [1],
          `Estas dependencias están declaradas pero nadie las importa: ${dead.slice(0, 6).join(', ')}${dead.length > 6 ? '…' : ''}. Peso muerto que instala todo el mundo al clonar.`,
          'Elimínalas de package.json (o muévelas a devDependencies si son herramientas de build).',
        ),
      )
    }
  }

  // Archivos huérfanos (nadie los importa y no son entry points).
  // En árbol parcial el grafo de inbound está incompleto: no se afirma.
  const orphanFiles = files
    .filter((f) => {
      if (f.content.length === 0) return false // solo ruta: no se sabe qué importa
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|vue|svelte)$/.test(f.path)) return false
      if ((inbound.get(f.path) ?? 0) > 0) return false
      const base = f.path.split('/').pop() ?? ''
      if (/^(index|main|app|server|cli|bin|__init__|mod|wsgi|manage)\.[a-z]+$/.test(base)) return false
      // archivos ruteados por convención del framework: nunca se importan
      if (/(^|\/)(app|pages|routes|screens|views)\//.test(`${f.path}/`)) return false
      if (/config|setup|\.d\.ts$|test|spec|stories|script/i.test(f.path)) return false
      return true
    })
    .map((f) => f.path)
    .sort()
  if (orphanFiles.length > 0 && !opts.partialTree) {
    findings.push(
      makeFinding(
        orphanFiles[0] ?? 'repo',
        'low',
        'overengineering',
        `${orphanFiles.length} archivo(s) huérfano(s)`,
        [1],
        `Ningún otro archivo importa estos módulos y no son entry points: ${orphanFiles.slice(0, 4).join(', ')}${orphanFiles.length > 4 ? '…' : ''}. La IA suele generar archivos "por si acaso" que nadie ejecuta.`,
        'Confirma si son punto de entrada externo (scripts, handlers); si no, elimínalos o conéctalos.',
      ),
    )
  }

  // .env commiteado
  if (envFiles.length > 0) {
    findings.push(
      makeFinding(
        envFiles[0] ?? '.env',
        'high',
        'security',
        `Archivo de entorno commiteado (${envFiles.length})`,
        [1],
        `El repositorio incluye ${envFiles.slice(0, 3).join(', ')}${envFiles.length > 3 ? '…' : ''}. Aunque esté vacío, es la causa #1 de filtraciones accidentales de secretos.`,
        'Agrega `.env*` a .gitignore, usa `.env.example` sin valores reales y rota cualquier credencial que haya existido ahí.',
      ),
    )
  }

  // Tests falsos (suite que no puede fallar, tautologías, skips)
  const fakeTests = detectFakeTests(files)
  findings.push(...fakeTests.findings)

  const languages = [...langCount.entries()]
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 5)
    .map(([l]) => l)

  return {
    findings,
    stats: { totalLines, languages, externalUsed: [...externalUsed].sort() },
    checks: {
      hasManifest,
      manifestName,
      envFiles,
      secretCount,
      brokenImports: findings.filter((f) => f.title.startsWith('Import fantasma')).map((f) => f.file),
      missingDeps: [...missingDepFiles.keys()],
      unusedDeps,
      orphanFiles,
      suspiciousTestFiles: fakeTests.suspiciousFiles,
    },
  }
}

/** Búsqueda de un path con distinto casing (para avisos) */
export function findCaseInsensitive(pathLower: string, map: Map<string, string>): string | null {
  return map.get(pathLower) ?? null
}
