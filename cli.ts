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
import { mergeAndScore, explainScore } from './src/lib/repo-score'
import { auditBatch, selectAuditFiles, synthesizeReport, type ReduceResult } from './src/lib/repo-llm'
import { getLLM, type LlmClient } from './src/lib/llm'
import { roastRepo } from './src/lib/roast'
import { buildFixPack } from './src/lib/fix-prompts'
import { CATEGORY_META, SEVERITY_META, VERDICT_META, verdictFromScore, type CategoryKey } from './src/lib/vibe-types'
import type { RepoFinding, RepoFile } from './src/lib/repo-types'

/** Truncado de contenido al leer: los archivos grandes aportan imports, no texto completo */
const READ_CAP = 64 * 1024

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
        // el contenido se trunca: los imports viven arriba del archivo
        out.push({ path: rel, content: readFileSync(abs, 'utf8').slice(0, READ_CAP) })
      } catch {
        /* ilegible: se ignora */
      }
    }
  }
}

function usage(): never {
  console.error(`Uso: bun cli.ts <carpeta> [--json] [--roast] [--exclude <ruta>] [--fix-pack] [--ai]

Opciones:
  --json             Salida JSON (para CI u otras herramientas)
  --roast            Añade el modo roast 🔥 (humor determinista, no evidencia)
  --exclude <ruta>   Excluye rutas del escaneo (repetible, ej. tests/fixtures)
  --fix-pack         Imprime los hallazgos como prompts de corrección (redirige a fixes.md)
  --ai               Añade la auditoría IA por lotes (requiere una API key en el entorno;
                     sin credenciales cae al modo determinista con un aviso)

Exit codes: 0 = SHIP IT / CASI LISTO · 1 = SOSPECHOSO / PELIGRO o error`)
  process.exit(1)
}

async function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const asRoast = args.includes('--roast')
  const excludes: string[] = []
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--exclude') {
      const val = args[i + 1]
      if (!val || val.startsWith('--')) usage()
      excludes.push(val!)
      i++
    } else if (arg && !arg.startsWith('--')) {
      positional.push(arg)
    }
  }
  const target = positional[0]
  if (!target) usage()

  const root = resolve(target!)
  if (!existsSync(root)) {
    console.error(`No existe la ruta: ${root}`)
    process.exit(1)
  }

  const files: RepoFile[] = []
  walkDir(root, root, files)
  const scanned =
    excludes.length > 0
      ? files.filter((f) => !excludes.some((ex) => f.path === ex || f.path.startsWith(`${ex}/`)))
      : files
  if (scanned.length === 0) {
    console.error('Ningún archivo escaneable (¿solo binarios o node_modules?).')
    process.exit(1)
  }

  const scan = scanRepo(scanned)
  const name = root.split('/').pop() ?? root

  // ── Auditoría IA opcional (--ai): mismos lotes que la web ──
  const asAI = args.includes('--ai')
  let llm: LlmClient | null = null
  if (asAI) {
    try {
      llm = await getLLM()
    } catch (e) {
      console.error(`⚠️  Configuración de IA inválida (${e instanceof Error ? e.message : e}) — corriendo determinista.`)
    }
    if (!llm) {
      console.error(
        '⚠️  --ai pedida pero no hay credenciales (GEMINI_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, ZAI_API_KEY u OLLAMA_MODEL) — corriendo determinista.',
      )
    }
  }
  const aiRaw: RepoFinding[] = []
  let narrative: ReduceResult | null = null
  let aiAuditedCount = 0
  if (llm) {
    const contentFiles = scanned.filter((f) => f.content.length > 0)
    const selection = selectAuditFiles(contentFiles, scan.checks.manifestName)
    const totalBatches = selection.batches.length
    aiAuditedCount = selection.auditedPaths.length
    console.error(`🤖 IA: ${llm.provider} · ${llm.model} — auditando ${selection.auditedPaths.length} archivos en ${totalBatches} lote(s)…`)
    let batchesFailed = 0
    for (const batch of selection.batches) {
      try {
        for (const f of await auditBatch(llm, scanned.map((x) => x.path), batch)) {
          aiRaw.push({ ...f, origin: 'ai' })
        }
      } catch (e) {
        batchesFailed++
        console.error(`⚠️  Un lote de IA falló (${e instanceof Error ? e.message : e}) — ese lote solo tiene escaneo determinista.`)
      }
    }
    if (totalBatches > 0 && batchesFailed === totalBatches) {
      console.error(`⚠️  Los ${totalBatches} lotes de IA fallaron — resultados solo del escaneo determinista.`)
    }
    narrative = await synthesizeReport(llm, {
      repoName: name,
      branch: null,
      stars: null,
      treePreview: scanned.map((f) => f.path),
      scanFindings: scan.findings,
      aiFindings: aiRaw,
      stats: {
        filesScanned: scanned.length,
        filesAudited: selection.auditedPaths.length,
        totalLines: scan.stats.totalLines,
        languages: scan.stats.languages,
        truncated: false,
      },
      externalUsed: scan.stats.externalUsed,
    })
  }

  const { categories, score } = mergeAndScore(scan.findings, aiRaw)
  const explanation = explainScore(categories, score)
  const verdict = verdictFromScore(score)
  const roast = asRoast
    ? roastRepo({
        repoName: name,
        verdict,
        signals: {
          secrets: scan.checks.secretCount,
          envCommitted: scan.checks.envFiles.length,
          phantomDeps: scan.checks.missingDeps.length,
          brokenImports: scan.checks.brokenImports.length,
          unusedDeps: scan.checks.unusedDeps.length,
          orphans: scan.checks.orphanFiles.length,
          fakeTests: scan.checks.suspiciousTestFiles.length,
        },
      })
    : null

  // fix pack: solo el documento de prompts a stdout, limpio para redirigir
  if (args.includes('--fix-pack') && !asJson) {
    console.log(
      buildFixPack({
        repoName: name,
        score,
        verdict,
        categories,
        scoreExplanation: explanation,
        engine: 'determinista',
      }),
    )
    process.exit(verdict === 'SOSPECHOSO' || verdict === 'PELIGRO' ? 1 : 0)
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          name,
          score,
          verdict,
          mode: llm ? `ia (${llm.provider} · ${llm.model})` : 'determinista (sin IA)',
          ai: llm
            ? { provider: llm.provider, model: llm.model, filesAudited: aiAuditedCount, findings: aiRaw.length }
            : null,
          summary: narrative?.summary ?? null,
          stats: { filesScanned: scanned.length, totalLines: scan.stats.totalLines, languages: scan.stats.languages },
          checks: scan.checks,
          categories,
          scoreExplanation: explanation,
          ...(roast ? { roast } : {}),
        },
        null,
        2,
      ),
    )
  } else {
    const v = VERDICT_META[verdict]
    console.log(llm ? `🕵️ VibeCheck — auditoría con IA (${llm.provider} · ${llm.model})` : `🕵️ VibeCheck — auditoría determinista (sin IA)`)
    console.log(`Repo: ${name} · ${scanned.length} archivos · ${scan.stats.totalLines} líneas`)
    if (scan.stats.languages.length) console.log(`Lenguajes: ${scan.stats.languages.join(', ')}`)
    console.log('')
    console.log(`  Vibe Score: ${score}/100 — ${v.emoji} ${verdict}`)
    console.log(`  ${v.message}`)
    console.log('')
    for (const key of Object.keys(categories) as CategoryKey[]) {
      const cat = categories[key]
      console.log(`  ${CATEGORY_META[key].icon} ${CATEGORY_META[key].label.padEnd(18)} ${String(cat.score).padStart(3)}/100 · ${cat.findings.length} hallazgo(s)`)
    }
    console.log('')
    console.log(`  ¿Por qué ${score}/100?`)
    if (explanation.deductions.length === 0 && !explanation.cap) {
      console.log('   🎉 Nada que descontar: no se encontró ningún hallazgo.')
    } else {
      for (const d of explanation.deductions) {
        const label = `${CATEGORY_META[d.category].label} (${SEVERITY_META[d.severity].label.toLowerCase()})`
        console.log(`   • −${d.cost} pts · ${d.count} hallazgo(s) de ${label}`)
      }
      if (explanation.cap) console.log(`   • ⬆️ ${explanation.cap.reason}`)
    }
    if (narrative) {
      console.log('')
      console.log('  🤖 Resumen (IA):')
      console.log(`   ${narrative.summary}`)
      for (const s of narrative.vibeSignals.slice(0, 3)) {
        console.log(`   • ${s.title}${s.detail ? ` — ${s.detail}` : ''}`)
      }
    }
    const findings = (Object.keys(categories) as CategoryKey[]).flatMap((k) => categories[k].findings)
    if (findings.length > 0) {
      console.log('')
      console.log('  Hallazgos:')
      for (const f of findings) {
        const sev = SEVERITY_META[f.severity]
        const lines = f.lines.length ? `:L${f.lines.slice(0, 3).join(',L')}` : ''
        const origin = f.origin === 'ai' ? '  🤖 IA' : ''
        console.log(`   • [${sev.label.toUpperCase()}] ${f.title} — ${f.file}${lines}${origin}`)
        console.log(`       ${f.explanation}`)
        console.log(`       Fix: ${f.fix}`)
      }
    }
    if (roast) {
      console.log('')
      console.log('  🔥 Modo roast (humor, no evidencia):')
      for (const line of roast) console.log(`   • ${line}`)
    }
    console.log('')
    console.log('  Modo determinista: reproducible, cero IA. Auditoría completa con IA en la app web.')
  }

  process.exit(verdict === 'SOSPECHOSO' || verdict === 'PELIGRO' ? 1 : 0)
}

main()
