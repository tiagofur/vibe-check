# Worklog

---
Task ID: 1
Agent: Z.ai Code (main agent)
Task: Crear un proyecto open source innovador con IA integrada para la comunidad dev — resultado: "VibeCheck", auditor de código para la era del vibe coding.

Work Log:
- Analicé la petición y descarté ideas saturadas (code reviewers, generadores de README, chatbots). Elegí un problema NUEVO (2025): la gente sube a producción código generado por IA ("vibe coding") sin revisarlo → alucinaciones, secretos filtrados, bugs sutiles y sobre-ingeniería.
- Diseñé VibeCheck: auditor con IA que evalúa 4 categorías (security / hallucination / bugs / overengineering) y produce un "Vibe Score" 0-100 con veredicto (SHIP IT / CASI LISTO / SOSPECHOSO / PELIGRO).
- Cargué el skill LLM y usé z-ai-web-dev-sdk en backend (route handler Node, nunca en cliente).
- Definí tipos y scoring compartidos en `src/lib/vibe-types.ts` (penalización determinista por severidad + ponderación: security 0.30, hallucination 0.30, bugs 0.25, overengineering 0.15) y 3 snippets de demo en `src/lib/samples.ts` (secretos, alucinaciones, sobre-ingeniería).
- Schema Prisma: modelo `VibeCheck` (id, title, language, score, verdict, codeLines, report JSON, createdAt) reemplazando modelos scaffold; `bun run db:push` OK.
- Backend: `POST /api/analyze` (validación zod, truncado a 12k chars, prompt de sistema estricto con JSON-only, extracción robusta de JSON con reintentos, normalización defensiva de findings, techo duro de score si hay críticos en security/hallucination → PELIGRO, guardado en DB), `GET /api/checks` (historial), `GET/DELETE /api/checks/[id]`.
- Frontend (dark theme con esmeralda/violeta/ámbar, sin azules): hero con terminal que escribe en vivo, analizador con textarea + drag&drop de archivos + select de lenguaje + 3 ejemplos, ScanProgress con pasos animados, ReportView (gauge SVG animado con gradiente rojo→esmeralda, MiniRings por categoría, accordions de hallazgos con fix sugerido, visor de código con líneas marcadas por severidad y salto a línea), historial con carga/eliminación, sección "Cómo funciona", footer sticky (mt-auto + safe-area).
- Corregí durante la verificación: (1) botones anidados dentro de AccordionTrigger → chips de línea convertidos a span[role=button] con soporte de teclado; (2) calibración indulgente del score (62 "CASI LISTO" con SQL injection) → techo de 35 con críticos de security/hallucination.
- Verificación end-to-end con Agent Browser: render OK sin errores de consola, 2 auditorías reales con LLM (23.2s y 20.6s) que detectaron TODAS las alucinaciones plantadas (redis-super-cache-pro, formatDateES, measureMemory, Sentry.captureMetrics, Array.chunk) y los secretos, salto a línea L7 resaltando el STRIPE_KEY, historial 3→2 al eliminar, responsive móvil 390px OK, footer OK, lint limpio, dev.log sin errores.

Stage Summary:
- App completa y verificada en `/` (única ruta visible): VibeCheck, auditor IA open source (MIT) para vibe coding.
- Artefactos clave: `src/lib/vibe-types.ts`, `src/lib/samples.ts`, `src/app/api/analyze/route.ts`, `src/app/api/checks/route.ts`, `src/app/api/checks/[id]/route.ts`, `src/components/vibe/score-gauge.tsx`, `src/components/vibe/report-view.tsx`, `src/components/vibe/scan-progress.tsx`, `src/app/page.tsx`, `prisma/schema.prisma` (modelo VibeCheck), layout con metadata/lang es, globals.css con utilidades (scrollbar-thin, vibe-scan, vibe-cursor).
- Decisiones: scoring determinista calculado en backend (no por el LLM) para consistencia; el código del usuario NO se persiste (privacy by design, solo el reporte); techo duro de veredicto ante críticos.

---
Task ID: 2
Agent: Z.ai Code (main agent)
Task: Pivotar VibeCheck de "auditor de snippets" a "auditor adversarial a nivel repositorio" (GitHub públicos + carpetas locales), tras el feedback del usuario sobre utilidad real y competencia (Claude Code / Codex).

Work Log:
- Definí el posicionamiento: due diligence independiente pre-clonación vs asistencia in-session de los IDEs IA. Diferenciadores: grafo de imports de TODO el repo, chequeos estructurales deterministas (reproducibles, sin LLM) y detección de alucinaciones cross-file.
- Prisma: nuevo modelo `VibeRepoCheck` (repoName, source, branch, score, verdict, filesScanned, filesAudited, totalLines, report JSON). db:push OK.
- `src/lib/repo-scan.ts` (motor determinista, cero LLM): filtro de árbol (skip dirs pesados/binarios/locks), riskScore por keywords (auth>pagos>secrets>db>api), extracción de imports JS/TS/Python, resolución de imports relativos con extensiones/index, chequeo de dependencias fantasma vs package.json (con excepción de auto-import del propio paquete), deps sin uso, secretos por patrones (AWS/Stripe/GitHub/Slack/BD con password/credenciales genéricas), .env commiteado, archivos huérfanos (sin inbound edges).
- `src/lib/repo-llm.ts` (orquestación IA): selectAuditFiles (triage top-32 por riesgo + hasta 3 tests + manifiesto, lotes ≤13k chars × 3), auditBatch (JSON estricto por lote con file/lines/severity/category), synthesizeReport (reduce: summary, architecture, vibeSignals, topRisks, categorySummaries). Salvamento de JSON truncado del LLM (recorta al último hallazgo completo y cierra el array).
- `POST /api/analyze-repo`: ingesta GitHub vía **tarball de codeload** (sin límites de la API de 60/h; probé API primero y la IP del sandbox la tenía agotada → refactor), extracción con tar + validación anti zip-slip, caps (40MB, 120 archivos leídos, 40KB/archivo); modo `files` (carpeta local) con mismos caps; merge scan+IA por categoría nativa (`RepoFinding.category`), scoring determinista con techos (crítico security/hallucination → ≤35), guardado en DB. `/api/repo-checks` + `/api/repo-checks/[id]` (GET/DELETE).
- UI: Tabs Repo GitHub / Carpeta local / Snippet (snippet se conserva); input URL con quick-links, zona de arrastre de carpetas con traversing real de entries (webkitGetAsEntry) + input webkitdirectory; ScanProgress con fases por modo; `RepoReportView` (gauge, chequeos estructurales con estados pass/warn/fail, riesgos principales, "¿Huele a vibe coding?" con señales, 4 categorías, hallazgos agrupados por archivo con filtro y badge "verificado" para hallazgos deterministas, copiar MD); historial unificado snippet+repo con iconos por fuente.
- Bugs corregidos durante la build: backticks anidados en template literal (parse error), icono lucide `ScanFolder` inexistente → `FolderSearch`, singleton de Prisma obsoleto tras db:push (reinicio del dev server), falso positivo de dependencia fantasma con auto-import del propio paquete (sindresorhus/slugify: 80→93), restauración accidental de `importedPkgs.add`.
- Verificación E2E: repo sintético "vibe-coded" por carpeta → detectó TODO lo plantado (left-pad-x fantasma, ./billing/pagos roto, 3 secretos, .env, lodash muerto, huérfano) con score 35 PELIGRO y persistencia OK; repo real sindresorhus/slugify desde la UI → 12 archivos escaneados, 11 auditados con IA, 1257 líneas, score 93-98 SHIP IT; historial unificado con 4 entradas; responsive móvil OK; lint limpio.

Stage Summary:
- VibeCheck 2.0: auditoría a nivel repo con motor determinista (grafo de imports + manifiesto + secretos, reproducible) + auditoría IA por lotes con triage de riesgo. GitHub públicos sin API keys (tarball), carpetas locales por drag&drop/webkitdirectory, snippet conservado.
- Artefactos: `src/lib/repo-types.ts`, `src/lib/repo-scan.ts`, `src/lib/repo-llm.ts`, `src/app/api/analyze-repo/route.ts`, `src/app/api/repo-checks/*`, `src/components/vibe/repo-report-view.tsx`, `scan-progress.tsx` (modos), `page.tsx` (tabs + carpetas), `prisma/schema.prisma` (+VibeRepoCheck).
- Límites conocidos: 120 archivos leídos/220 escaneados por run (árbol completo para el grafo), repos >40MB comprimidos no soportados, privados requieren token (próximo paso natural: OAuth con NextAuth), sin CI yet (GitHub Action sería el siguiente hito).

---
Task ID: 3
Agent: ZCode (GLM)
Task: Implementar las 4 mejoras priorizadas del review externo de ChatGPT: score explicable, detector determinista de tests falsos, modo roast, y GitHub Action con quality gate + dogfooding (self-audit).

Work Log:
- **Score explicable**: `explainScore()` en `src/lib/repo-score.ts` deduce del reporte cuánto cuesta cada grupo (categoría × severidad: peso de severidad × peso de categoría, 1 decimal) y detecta techos duros (rawWeighted > score → cap). Tipo `ScoreExplanation`/`ScoreDeduction` en repo-types, campo opcional `scoreExplanation` en `RepoReport` (retrocompatible con caché). UI: tarjeta "¿Por qué N/100?" en RepoReportView (calcula client-side si el reporte cacheado no lo trae), CLI (texto + JSON) y export MD.
- **Detector de fake tests**: nuevo `src/lib/fake-tests.ts` (cero LLM): suites que no pueden fallar (declara it/test y cero expect/assert — JS/TS y Python), assertions tautológicas (pares de literales idénticos, identificadores iguales via backreference, truthy/falsy triviales), cuerpos de test vacíos y tests saltados (.skip/.todo/xit, @pytest.mark.skip). Un finding por archivo y tipo, categoría bugs. Integrado en scanRepo + `ScanChecks.suspiciousTestFiles` + structural check "test-integrity". Fixture: login.test.ts (tautología+vacío+skip) y session.test.ts (sin asserts), vitest añadido a devDeps del fixture; vitest.config excluye tests/fixtures para que el fake test plantado no corra como suite real.
- **Modo roast**: `src/lib/roast.ts` — 1-5 frases sarcásticas 100% deterministas (djb2 del repoName + pools por veredicto/regla; señales desde structural checks en web y desde scan.checks en CLI). UI: botón "Modo roast" + tarjeta fuego con disclaimer y copiar MD; CLI: `--roast` (texto y JSON).
- **CLI --exclude**: flag repetible de prefijos de ruta, necesario para el self-audit (excluir tests/ y samples.ts).
- **GitHub Action**: docs/vibecheck-action.yml ahora audita en modo diff contra `github.event.pull_request.base.sha`, incluye el desglose "¿por qué este score?" en el comentario (jq sobre scoreExplanation, tolera caché vieja) y gatea: falla si score < `vars.VIBECHECK_MIN_SCORE` (default 60) con comentario explicándolo.
- **Self-audit (dogfooding)**: nuevo .github/workflows/self-audit.yml — en push a main corre `bun cli.ts . --exclude tests --exclude src/lib/samples.ts --json --roast` y publica score + desglose + roast en el job summary (script bun -e a GITHUB_STEP_SUMMARY). No bloqueante (continue-on-error). Local da 90/100 SHIP IT (con .env local); en CI ~95.
- **Fix de motor (falsos positivos descubiertos al auto-auditar)**: (1) aliases de tsconfig/jsconfig vía `parseAliasConfig`/`applyAlias` — con stripper JSONC que respeta strings (el `/*` de `"@/*"` NO es un comentario; la regex ingenua borraba el mapping completo) y resolución raíz-relativa (fromRoot); (2) imports hacia directorios generados (.next, dist) dejan de marcarse como fantasma; (3) page.tsx de 47KB superaba el cap de 40KB de isScannablePath y salía del grafo (todos sus componentes parecían huérfanos): techo de inclusión 256KB + truncado de contenido a 64KB al leer (walkDir y extractAndRead); (4) archivos ruteados por convención (app/, pages/, routes/, screens/, views/) y cli/bin no se reportan como huérfanos. Neto del self-audit: de 35/100 PELIGRO con 17 hallazgos (11 falsos) a 90/100 SHIP IT con solo hallazgos reales.
- Docs: README.md + README.es.md — tagline ("Before you ship it, VibeCheck it." / "Antes de subirlo, hazle VibeCheck."), badge de self-audit, tests 43→75, desglose explicable, detector de fake tests, roast, flags del CLI, Action con gate y diff, sección "VibeCheck audita a VibeCheck".

Stage Summary:
- VibeCheck responde la crítica principal del review ("¿por qué 78?"): todo score trae recibo punto por punto en web/CLI/JSON/MD y el Action lo pega en el PR.
- Los tests falsos — la idea que más gustó del review — son ahora un check determinista reproducible (JS/TS + Python) con fixture plantado; antes solo vivían en el prompt de IA.
- El roast mode (compartible, determinista, separado de la evidencia) y el gate configurable del Action abren el camino a calidad de CI/CD era-IA.
- El auto-audit forzó 4 arreglos reales del motor (aliases, generados, archivos grandes, rutas de framework) que mejoran la auditoría de CUALQUIER repo Next.js/React, no solo el propio.
- Artefactos: `src/lib/roast.ts`, `src/lib/fake-tests.ts`, `explainScore()` en `repo-score.ts`, `src/lib/repo-types.ts` (+ScoreExplanation), `repo-report-view.tsx` (desglose + roast), `cli.ts` (--roast/--exclude/desglose), `analyze-repo/route.ts` (scoreExplanation + test-integrity), `docs/vibecheck-action.yml` (gate+diff), `.github/workflows/self-audit.yml`, fixture +2 tests falsos, tests: score-explain/fake-tests/roast suites (75 en verde).
- Pendiente (roadmap): publicar CLI en npm, atribución de score en tendencias por PR, OAuth.

---
Task ID: 4
Agent: ZCode (GLM)
Task: Arreglar los dos bloqueos que reportó el usuario al probar: repos de GitHub >40MB (error duro del tarball) y carpetas locales con node_modules (browser colgado + topes ridículos).

Work Log:
- Diagnóstico: (1) fetchTarball descargaba el tarball COMPLETO a un Buffer y lanzaba error si pasaba 40MB comprimido, sin plan B; (2) filesFromDataTransfer (drag&drop) recorría node_modules entero llamando .file() por cada archivo ANTES de filtrar, y los caps eran 300 archivos / 900KB / 40KB por archivo — inútil para un proyecto React real.
- **tar-gz.ts (nuevo, cero deps)**: parser tar incremental sobre el stream del codeload — Readable.fromWeb → createGunzip → BlockReader de bloques 512B con cola; soporta ustar (name+prefix), pax 'x' (lo que emiten los tarballs de GitHub para paths largos), GNU longname 'L' y pax global 'g'; directorios no se entregan. readTarTree(): cuenta TODAS las entradas escaneables (treeCount real) y retiene contenido solo del TopRiskKeeper (top-N por riskScore, evicción sin leer lo que no cabe, lectura truncada a 64KB). Guard de descompresión 1.5GB con mensaje dinámico. Errores claros de tarball truncado/corrupto. buildTarBuffer() construye tars en memoria para los tests (incluye pax y longname).
- **route.ts**: fuera fetchTarball/extractAndRead/writeTempTar (y el error de 40MB); downloadTree() descarga en streaming con hash sha256 del stream (caché intacta) vía TransformStream; timeout 45s→120s. Modo diff: ambos árboles hasta 4000 archivos (antes 120, el diff era aún más aproximado). DESCUBIERTO EN LA PRUEBA: next.js usa 'canary' como default — añadido fetchDefaultBranch() (1 llamada API solo si main/master dan 404). IngestResult ganó `truncated` (honestidad del badge).
- **folder-pick.ts (nuevo, puro, compartido cliente/servidor)**: FOLDER_CAPS (800 archivos, 8MB total, ≤256KB por archivo, lectura 64KB, 20k candidatos), HEAVY_DIR_NAMES, pickDecision() ('ok' | heavy-dir | binary | too-big | no-ext) y omittedSummary() para el toast. page.tsx: el walker ya NO desciende a node_modules/.git/dist... (ni un .file() dentro) + tope de candidatos; readFolder() filtra antes de leer con contadores; toasts "X archivos listos · Y no elegibles · Z por tope"; dropzone actualizado (256KB/800).
- **route.ts server**: zod alineado (800 archivos, contenido ≤128KB, superRefine de presupuesto total 8MB), MAX_SCAN_FILES 220→600.
- Verificación E2E real (server local en 3001): facebook/react (tarball >40MB) → "Árbol leído en streaming: 7073 archivos escaneables — contenido del top 120 por riesgo", 195 hallazgos del grafo, falla solo en ZAI.create() (sin .z-ai-config) = ingesta completa OK. tiagofur/dev_deck (pedido por el usuario para pruebas) → 712 archivos, 48 hallazgos, mismo punto de corte sano. Caps: 850 archivos → HTTP 400; 500 archivos → pasa hasta la IA. 94 tests.
- READMEs (es+en): "Límites honestos" reescritos — repos de cualquier tamaño, diff hasta 4000, caps de carpeta nuevos.

Stage Summary:
- El error ">40 MB comprimido" de la captura del usuario ya no existe: cualquier repo de GitHub audita con memoria acotada (streaming, top-120 por riesgo) y conteo real del árbol.
- Las carpetas locales con node_modules funcionan: el walker ni las camina, y los topes (800×256KB/8MB) permiten proyectos reales.
- Argyectos: src/lib/tar-gz.ts, src/lib/folder-pick.ts, route.ts (downloadTree/fetchDefaultBranch/zod), page.tsx (walker+readFolder+toasts), tests tar-gz+folder-pick (94 en verde).
- Pendiente: probar el flujo de carpeta en el navegador real (drag&drop manual del usuario); con .z-ai-config, dev_deck debería auditar de punta a punta.
