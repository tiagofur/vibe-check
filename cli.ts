#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────
// VibeCheck CLI · auditoría determinista local, sin servidor ni LLM
//
//   bun cli.ts <carpeta> [--json]
//
// Revisa dependencias fantasma, imports rotos, secretos, .env,
// dependencias muertas y archivos huérfanos. Exit code 1 si el
// veredicto es SOSPECHOSO o PELIGRO → usable como gate en CI.
// Para la auditoría completa con IA, usa la app web.
// ─────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { isScannablePath, scanRepo, SKIP_DIRS } from './src/lib/repo-scan'
import { mergeAndScore } from './src/lib/repo-score'
import { CATEGORY_META, SEVERITY_META, VERDICT_META, verdictFromScore, type CategoryKey } from './src/lib/vibe-types'
import type { RepoFile } from './src/lib/repo-types'

function walkDir(dir: string, root: string, out: RepoFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkDir(abs, root, out)
    } else if (entry.isFile()) {
      const rel = relative(root, abs).split('\\').join('/')
      const size = statSync(abs).size
      if (!isScannablePath(rel, size)) continue
      try {
        out.push({ path: rel, content: readFileSync(abs, 'utf8') })
      } catch {
        /* ilegible: se ignora */
      }
    }
  }
}

function usage(): never {
  console.error(`Uso: bun cli.ts <carpeta> [--json]

Opciones:
  --json   Salida JSON (para CI u otros herramientas)

Exit codes: 0 = SHIP IT / CASI LISTO · 1 = SOSPECHOSO / PELIGRO o error`)
  process.exit(1)
}

async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) usage()

  const root = resolve(target!)
  if (!existsSync(root)) {
    console.error(`No existe la ruta: ${root}`)
    process.exit(1)
  }

  const files: RepoFile[] = []
  walkDir(root, root, files)
  if (files.length === 0) {
    console.error('Ningún archivo escaneable (¿solo binarios o node_modules?).')
    process.exit(1)
  }

  const scan = scanRepo(files)
  const { categories, score } = mergeAndScore(scan.findings, [])
  const verdict = verdictFromScore(score)
  const name = root.split('/').pop() ?? root

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          name,
          score,
          verdict,
          mode: 'determinista (sin IA)',
          stats: { filesScanned: files.length, totalLines: scan.stats.totalLines, languages: scan.stats.languages },
          checks: scan.checks,
          categories,
        },
        null,
        2,
      ),
    )
  } else {
    const v = VERDICT_META[verdict]
    console.log(`🕵️ VibeCheck — auditoría determinista (sin IA)`)
    console.log(`Repo: ${name} · ${files.length} archivos · ${scan.stats.totalLines} líneas`)
    if (scan.stats.languages.length) console.log(`Lenguajes: ${scan.stats.languages.join(', ')}`)
    console.log('')
    console.log(`  Vibe Score: ${score}/100 — ${v.emoji} ${verdict}`)
    console.log(`  ${v.message}`)
    console.log('')
    for (const key of Object.keys(categories) as CategoryKey[]) {
      const cat = categories[key]
      console.log(`  ${CATEGORY_META[key].icon} ${CATEGORY_META[key].label.padEnd(18)} ${String(cat.score).padStart(3)}/100 · ${cat.findings.length} hallazgo(s)`)
    }
    const findings = (Object.keys(categories) as CategoryKey[]).flatMap((k) => categories[k].findings)
    if (findings.length > 0) {
      console.log('')
      console.log('  Hallazgos:')
      for (const f of findings) {
        const sev = SEVERITY_META[f.severity]
        const lines = f.lines.length ? `:L${f.lines.slice(0, 3).join(',L')}` : ''
        console.log(`   • [${sev.label.toUpperCase()}] ${f.title} — ${f.file}${lines}`)
        console.log(`       ${f.explanation}`)
        console.log(`       Fix: ${f.fix}`)
      }
    }
    console.log('')
    console.log('  Modo determinista: reproducible, cero IA. Auditoría completa con IA en la app web.')
  }

  process.exit(verdict === 'SOSPECHOSO' || verdict === 'PELIGRO' ? 1 : 0)
}

main()
