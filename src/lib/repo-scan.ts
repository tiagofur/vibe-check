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
  { re: /(?:api[_-]?key|apikey|secret|password|passwd|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i, title: 'Credencial hardcodeada', severity: 'high' },
]

export interface ManifestInfo {
  name: string | null
  deps: Set<string>
  allDeps: Set<string>
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

/** ¿Este path del árbol vale la pena escanearse? (sin contenido) */
export function isScannablePath(path: string, size: number): boolean {
  if (path.includes('..')) return false
  const segs = path.split('/')
  if (segs.some((s) => SKIP_DIRS.has(s))) return false
  if (isLockFile(path)) return false
  const ext = extOf(path)
  if (!ext || BINARY_EXT.has(ext)) return false
  if (size > 40 * 1024) return false
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

export function scanRepo(files: RepoFile[]): ScanResult {
  const findings: RepoFinding[] = []
  const pathSet = new Set(files.map((f) => f.path))
  const pathLower = new Map(files.map((f) => [f.path.toLowerCase(), f.path]))
  const manifestFile =
    files.find((f) => f.path === 'package.json') ??
    files.find((f) => f.path === 'go.mod') ??
    files.find((f) => f.path === 'requirements.txt') ??
    files.find((f) => f.path === 'Cargo.toml') ??
    null

  // ── Manifiesto ──────────────────────────────────────────
  const manifest: ManifestInfo = { name: null, deps: new Set(), allDeps: new Set() }
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
  } else if (manifestFile) {
    hasManifest = true
    manifestName = manifestFile.path
  }

  // ── Escaneo por archivo ──────────────────────────────────
  const externalUsed = new Set<string>()
  const importedPkgs = new Set<string>()
  const inbound = new Map<string, number>()
  const langCount = new Map<string, number>()
  let totalLines = 0
  const envFiles: string[] = []
  let secretCount = 0
  const missingDepFiles = new Map<string, string[]>()

  for (const f of files) {
    totalLines += f.content.split('\n').length
    const lang = langLabel(f.path)
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)

    const base = f.path.split('/').pop() ?? ''
    if (base.startsWith('.env') || f.path.includes('/.env')) {
      envFiles.push(f.path)
    }

    // Secretos (máx 3 matches por archivo para no inundar)
    let fileSecrets = 0
    for (const { re, title, severity } of SECRET_PATTERNS) {
      const m = f.content.match(re)
      if (m && fileSecrets < 3) {
        fileSecrets++
        secretCount++
        findings.push(
          makeFinding(
            f.path,
            severity,
            'security',
            title,
            [lineOf(f.content, m[0])],
            `Se detectó "${title}" dentro del repositorio. Si el repo es público, la credencial ya debe considerarse comprometida.`,
            'Revoca la credencial inmediatamente, muévela a variables de entorno (.env excluido del repo) y limpia el historial de git si hace falta.',
          ),
        )
      }
    }

    // Imports
    for (const mod of extractModules(f.path, f.content)) {
      if (isRelative(mod)) {
        if (f.path.endsWith('.py')) continue
        if (!resolves(f.path, mod, pathSet)) {
          findings.push(
            makeFinding(
              f.path,
              'high',
              'hallucination',
              'Import fantasma: módulo local inexistente',
              [lineOf(f.content, mod)],
              `El archivo importa "${mod}" pero esa ruta no existe en el repositorio. La IA escribió una llamada a un módulo que nunca creó: el build falla en cuanto se ejecuta.`,
              'Crea el módulo faltante, corrige la ruta del import o elimina la dependencia si no se usa.',
            ),
          )
        } else {
          const target = normalizeRel(f.path, mod)
          const resolved =
            RESOLVE_EXTS.map((e) => target + e).find((p) => pathSet.has(p)) ??
            INDEX_BASES.map((i) => RESOLVE_EXTS.slice(1).map((e) => target + i + e)).flat().find((p) => pathSet.has(p))
          if (resolved) inbound.set(resolved, (inbound.get(resolved) ?? 0) + 1)
        }
      } else if (!isBuiltin(mod)) {
        const pkg = pkgOf(mod)
        if (!pkg) continue
        externalUsed.add(pkg)
        importedPkgs.add(pkg)
        // auto-import del propio paquete (patrón estándar para tests) no es fantasma
        const isSelfRef = manifest.name !== null && pkg === manifest.name
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

  // Dependencias muertas (declaradas y nunca importadas)
  if (hasManifest && manifestName === 'package.json') {
    const unused = [...manifest.deps].filter(
      (d) => !importedPkgs.has(d) && !d.startsWith('@types/') && !d.startsWith('@'),
    )
    if (unused.length > 0) {
      findings.push(
        makeFinding(
          'package.json',
          'low',
          'overengineering',
          `${unused.length} dependencia(s) sin uso`,
          [1],
          `Estas dependencias están declaradas pero nadie las importa: ${unused.slice(0, 6).join(', ')}${unused.length > 6 ? '…' : ''}. Peso muerto que instala todo el mundo al clonar.`,
          'Elimínalas de package.json (o muévelas a devDependencies si son herramientas de build).',
        ),
      )
    }
  }

  // Archivos huérfanos (nadie los importa y no son entry points)
  const orphanFiles = files
    .filter((f) => {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|vue|svelte)$/.test(f.path)) return false
      if ((inbound.get(f.path) ?? 0) > 0) return false
      const base = f.path.split('/').pop() ?? ''
      if (/^(index|main|app|server|__init__|mod|wsgi|manage)\.[a-z]+$/.test(base)) return false
      if (/config|setup|\.d\.ts$|test|spec|stories|script/i.test(f.path)) return false
      return true
    })
    .map((f) => f.path)
    .sort()
  if (orphanFiles.length > 0) {
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
      unusedDeps: [...manifest.deps].filter((d) => !importedPkgs.has(d) && !d.startsWith('@types/')),
      orphanFiles,
      suspiciousTestFiles: fakeTests.suspiciousFiles,
    },
  }
}

/** Búsqueda de un path con distinto casing (para avisos) */
export function findCaseInsensitive(pathLower: string, map: Map<string, string>): string | null {
  return map.get(pathLower) ?? null
}
