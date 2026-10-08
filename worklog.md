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

---
Task ID: 5
Agent: ZCode (GLM)
Task: Dos bugs del testeo del usuario: el selector local solo permitía archivos (no carpetas) y GitHub seguía fallando sin credenciales de IA — pedir opciones.

Work Log:
- **Selector de carpetas**: el input con webkitdirectory vive en el tab "Carpeta local", que Radix desmonta al no estar activo. El useEffect de mount corría con el ref en null → el atributo nunca se aplicaba → diálogo en modo archivos. Fix: atributos webkitdirectory/directorio en el propio JSX (spread con cast), inmunes al timing de montaje. Verificado en navegador: el input monta con los atributos puestos.
- **Modo determinista sin IA (fallback)**: nuevo src/lib/deterministic-report.ts — buildDeterministicNarrative() redacta summary/arquitectura/vibeSignals/topRisks/summaries SOLO con hechos del escaneo (conteos, críticos/altos, señales derivadas de structural checks con count>0, topRisks = críticos+altos cap 4). route.ts: ZAI.create() en try/catch → engine='determinista', se salta la auditoría IA y la síntesis se construye tras el scoring (necesita verdict/categories del paso 6). RepoReport ganó engine?: 'ia' | 'determinista'. UI: badge "⚡ modo determinista (sin IA)" junto al veredicto. 95 tests (2 nuevos del narrative).
- E2E sin IA en local: tiagofur/dev_deck de punta a punta → 35/100 PELIGRO, 712 archivos, 16 hallazgos (1 crítico, 14 altos), señales: secretos, .env commiteado, imports rotos, huérfanos. Badge visible en el reporte del historial (captura verificada en navegador).
- READMEs: la nota del Quick start ahora explica el fallback automático sin credenciales.

Stage Summary:
- La app es funcional al 100% sin .z-ai-config: cualquier repo de GitHub o carpeta local produce reporte completo (score explicable, chequeos, roast) con badge de modo determinista; con credenciales, la IA se agrega encima.
- Arreglos: page.tsx (webkitdirectory en JSX), deterministic-report.ts (nuevo), route.ts (try/catch ZAI + narrativa post-scoring), repo-types (engine), repo-report-view (badge).

---
Task ID: 6
Agent: ZCode (GLM)
Task: Exportar el reporte como prompts de corrección ("fix pack") para corregir hallazgo por hallazgo con un agente IA.

Work Log:
- src/lib/fix-prompts.ts (puro): buildFindingPrompt() — prompt autocontenido por hallazgo (archivo+líneas, [SEVERIDAD · categoría], problema, corrección sugerida, instrucción de limitar el cambio y re-auditar); buildFixPack() — documento MD con encabezado (score/veredicto/motor/fecha), desglose "¿por qué este score?" (scoreExplanation), checklist con checkboxes ordenada por severidad (scan ✓verificado antes que ai) y un prompt por hallazgo en bloque de código. FixPackInput = Pick del RepoReport para que el CLI pueda construirlo sin síntesis IA.
- UI (repo-report-view.tsx): botón "Fix pack" en las acciones del veredicto (descarga vibecheck-fixes-<repo>.md vía Blob + copia al portapapeles con degradación amable si no hay permiso) y botón "Copiar prompt de corrección" dentro de cada hallazgo del acordeón.
- CLI: --fix-pack imprime solo el pack a stdout (redirigible a fixes.md), mantiene exit codes de gate.
- Tests: fix-prompts.test.ts (orden severidad/scan-primero, prompt autocontenido, checklist sincronizada con secciones, desglose del score, repo limpio "Nada que corregir", marca ✓verificado). 101 tests en verde.
- Verificado en navegador con el reporte determinista de dev_deck: botón Fix pack visible, prompt individual copiado (toast con archivo). Nota: dev_deck tiene hallazgos REALES — AWS Access Key y token de GitHub en SecretScannerTool.tsx (probablemente ejemplos de la propia herramienta, pero hay que revisarlo).

Stage Summary:
- Del reporte a la corrección: el usuario puede descargar el fix pack completo (checklist + prompts por severidad) o copiar el prompt de un hallazgo puntual desde el acordeón, pegarlo en Cursor/Claude/Copilot, corregir, y re-auditar. Cierra el ciclo del producto: auditar → entender → corregir → re-auditar.

---
Task ID: 7
Agent: ZCode (GLM)
Task: Eliminar los falsos positivos masivos del motor determinista (reporte real: 64 "imports fantasma" y 55/100 en un proyecto sano con alias @/*).

Work Log:
- Causa raíz: el grafo solo ve el top-N por riesgo. En GitHub (120 archivos) y en carpetas (>600), tsconfig.json/package.json quedaban fuera → parseAliasConfig(undefined) → cada import "@/…" era "fantasma"; y con muestra parcial, archivos cuyo importador fue descartado aparecían como "huérfanos" y deps usadas como "sin uso".
- folder-pick.ts: STRUCTURAL_FILES + isStructuralFile() — manifiesto y tsconfig/jsconfig/go.mod/requirements/Cargo nunca se recortan.
- tar-gz.ts: TopRiskKeeper retiene los estructurales aparte (no consumen cupo) y readTarTree devuelve allPaths (árbol escaneable completo, cap 50k) para resolver imports fuera de la muestra.
- repo-scan.ts: scanRepo(files, { allPaths?, partialTree? }) — archivos solo-ruta (content: '') nutren el grafo sin sumar líneas/secretos/hallazgos; partialTree suprime los hallazgos que exigen grafo completo (deps sin uso, huérfanos; los checks los conservan como conteo observado); alias sin '*' ya no captura por prefijo (@lib no atrapa @libfoo); deps sin uso ahora incluye paquetes con scope (@dnd-kit/*) pero con guarda de "mención por string" en configs/dotfiles pequeños (los md/txt no cuentan: documentar no es usar).
- Regex de credenciales: lookbehind (?<![A-Za-z-]) — autoComplete='new-password' : 'current-password' ya no es "Credencial hardcodeada"; las claves reales (password=, MY_SECRET=) siguen detectándose.
- analyze-repo/route.ts: ingesta de carpeta garantiza estructurales y conserva excedentes como solo-ruta; auditPool filtra solo-ruta antes del LLM; panel estructural anota "(muestra parcial del árbol)" en deps sin uso/huérfanos; caché bumpada a repo:v2 (los reportes pre-alias no se sirven).
- page.tsx (cliente): readFolder deja pasar package.json/tsconfig aunque se llegue a los topes de archivos/bytes.
- deterministic-report.ts: la arquitectura decía "Grafo de imports de 0 archivos leídos" (confundía filesAudited=IA con el grafo); ahora "N archivos escaneados".
- Tests: +13 (allPaths resuelve fuera de muestra, partialTree suprime, solo-ruta, autoComplete, password real, scope sin uso, mención en config, alias estricto, keeper estructural, allPaths del tar, isStructuralFile, narrativa honesta). 114 en verde, tsc/eslint/build limpios.

Stage Summary:
- Un proyecto Next.js sano con @/* ya no recibe −288 puntos inventados: el grafo garantiza manifiesto+tsconfig, resuelve contra el árbol completo y se niega a afirmar lo que la muestra no alcanza a probar. La credibilidad del auditor (cero falsos positivos de resolvedor) era el bug #1 del producto.

---
Task ID: 8
Agent: ZCode (GLM)
Task: Capa LLM multi-provider con trae-tu-propia-key (Gemini AI Studio, OpenRouter, OpenAI, Anthropic, Z.ai/GLM, Ollama local) — reemplaza el acoplamiento al SDK z-ai-web-dev-sdk.

Work Log:
- src/lib/llm.ts (nuevo): cliente único OpenAI-compatible en fetch puro (cero deps). SPECS por provider (endpoint, default model del tier económico, headers, thinking/max_tokens). buildChatRequest/parseChatResponse puros y testeables; normaliza el primer mensaje 'assistant' (quirk del SDK legacy) a 'system' para todos los providers. getLLM(): LLM_PROVIDER explícito (o 'none' para apagar) → auto-detección por presencia de key (gemini → openrouter → openai → anthropic → zai → ollama) → SDK legacy (.z-ai-config) como último recurso → null = modo determinista intacto. Overrides: LLM_MODEL global, LLM_BASE_URL (proxies/gateways), modelEnv/baseUrlEnv por provider (OLLAMA_MODEL/ZAI_BASE_URL). Timeouts 120s y errores HTTP con detalle accionable.
- Providers: Gemini AI Studio (gemini-2.5-flash), OpenRouter (google/gemini-2.5-flash + attribution headers), OpenAI (gpt-5-mini), Anthropic vía capa compat OpenAI (claude-haiku-4-5, x-api-key + anthropic-version + max_tokens 8192), Z.ai directo api.z.ai (glm-4.6, thinking disabled), Ollama local (sin key, requiere OLLAMA_MODEL).
- Refactor: repo-llm.ts (chatJSON/auditBatch/synthesizeReport toman LlmClient, sin tipo ZAI), analyze/route.ts (503 con mensaje accionable si no hay IA configurada) y analyze-repo/route.ts (el progreso NDJSON ahora anuncia provider·modelo; configuración inválida cae a determinista).
- .env.example extendido (todas las keys + overrides comentados); READMEs bilingües: sección "Bring your own key" con tabla provider/default/por qué; keys solo server-side.
- Tests: tests/llm.test.ts (18) — wire format por provider (system normalizado, thinking solo en GLM, headers Anthropic/OpenRouter, override LLM_BASE_URL), parseo, y matriz de selección (auto-orden, explícito gana, none apaga, inválido/sin key lanzan, ollama por modelEnv, LLM_MODEL). Smoke E2E con Bun.serve mock: petición (auth/model/system) y parseo verificados contra endpoint local. 132 tests en verde; tsc/eslint/build limpios.

Stage Summary:
- VibeCheck deja de depender del sandbox Z.ai para tener IA: cualquier key de Gemini/OpenRouter/OpenAI/Anthropic/GLM/Ollama enciende el auditor completo, con defaults baratos y fallback determinista siempre de por medio. La Action de PR (docs/vibecheck-action.yml) ahora es desplegable con una sola GEMINI_API_KEY en la instancia.

---
Task ID: 9
Agent: ZCode (GLM)
Task: Actualizar los defaults de modelos a la generación actual (verificado contra catálogos reales, oct 2026) y adoptar el router gratis de OpenRouter.

Work Log:
- Investigación con fuentes vivas: catálogo público de OpenRouter (/api/v1/models, 468 ids con precios reales) y docs de Google AI Studio. Defaults anteriores eran una generación vieja.
- Nuevos defaults en llm.ts: gemini → gemini-3.8-flash (nuevo flash estable; en OpenRouter $0.75/$3.75 por M — más nuevo Y más barato que 3.5-flash); openrouter → openrouter/free (router oficial que elige al azar un modelo :free disponible, $0; se puede fijar uno con LLM_MODEL, ej. nvidia/nemotron-3-ultra-550b-a55b:free); openai → gpt-6-luna ($0.10/$0.50, el "luna" que el usuario señalaba como barato); anthropic → claude-haiku-5.5 ($0.10/$0.50); zai → glm-5.3-flash ($0.15/$0.50, la generación que impulsa el propio CLI de este entorno).
- READMEs + .env.example actualizados con la tabla nueva y la nota del router free. Tests re-anclados a los defaults nuevos. 132 tests, tsc/eslint limpios.

Stage Summary:
- Los defaults ya no envejecen a ciegas: quedaron anclados a precios y ids verificados en los catálogos vivos, con el router gratuito de OpenRouter como default del provider "muchos modelos".

---
Task ID: 10
Agent: ZCode (GLM)
Task: --ai en el CLI — auditoría IA por lotes sin servidor, para revisar apps locales con una sola línea.

Work Log:
- cli.ts: flag --ai — getLLM() → selectAuditFiles/auditBatch/synthesizeReport (mismos lotes que la web) → mergeAndScore(scan.findings, aiRaw con origin:'ai'). Progreso y avisos por stderr (stdout queda limpio para --json/--fix-pack); sin credenciales cae al determinista con aviso honesto; config inválida ídem. Salida humana: encabezado "auditoría con IA (provider · model)", bloque "🤖 Resumen (IA)" con summary + 3 señales, hallazgos etiquetados 🤖 IA vs ✓ escaneo. JSON: mode/ai{provider,model,filesAudited,findings}/summary. Fix: 'name' se usaba antes de declararse (ReferenceError al sintetizar).
- tests/cli-ai.test.ts (3): E2E real — mock LLM como PROCESO aparte (spawn node -e con puerto efímero) porque dentro del worker de vitest spawnSync bloquea el event loop y el fetch del CLI entra en deadlock (60s de timeout, status null); cubre fallback sin credenciales, ida y vuelta del hallazgo del mock con etiqueta 🤖, y bloque ai/summary del JSON. 135 tests.
- READMEs: --ai en la sección CLI.

Stage Summary:
- "¿Cómo reviso mi app con IA?" ahora tiene respuesta de una línea: bun cli.ts <carpeta> --ai (o la web, que ya la tenía). El CLI ya no es determinista-only: mismo motor de IA que la API, sin servidor ni base de datos, con la key del .env.

---
Task ID: 11
Agent: ZCode (GLM)
Task: Visibilidad de fallos de IA — "¿cómo sabemos que la IA está funcionando y si falla avisa?" El usuario la hizo mientras corria una auditoria real.

Work Log:
- Hueco encontrado: auditBatch se tragaba los errores (console.error + return []) — un lote que fallaba (rate limit del router free, modelo que devuelve prosa) dejaba 0 hallazgos IA y el reporte igual se vendia como "con IA".
- repo-llm.ts: auditBatch ya no captura — propaga al caller (console.error del caller informa).
- analyze-repo/route.ts: try/catch por lote → evento de progreso "⚠️ El lote N de IA falló (<error real>) — ese lote solo tiene escaneo determinista"; auditedPaths ahora solo cuenta lotes EXITOSOS (filesAudited honesto); si fallan TODOS los lotes → engine='determinista' (badge ⚡ honesto) + aviso; fallo parcial → la fase de síntesis lo anuncia "(⚠️ N lote(s) de IA fallaron)".
- cli.ts: mismo tratamiento — warning por lote a stderr + "Los N lotes de IA fallaron" si es total.
- tests/cli-ai.test.ts: 4º test con mock que responde 500 — aserta el aviso por lote con el error real en stderr, el aviso de fallo total y la ausencia del hallazgo mock. 136 tests.

Stage Summary:
- La IA ya no puede fallar en silencio: fallo de lote es visible en vivo (progreso NDJSON o stderr), filesAudited mide lotes exitosos y el badge solo dice "con IA" si la IA aportó algo.

---
Task ID: 12
Agent: ZCode (GLM)
Task: Los 4 falsos positivos del reporte de dev_deck (29/100) — workspaces pnpm, secretos de demo, aliases anidados y .env.example. Verificación del usuario contra el código real.

Work Log:
- Baseline reproducido con el CLI real: 35/100 PELIGRO, 42 deps fantasma (incluido "@/lib"), 13 secretos (AWS demo en crítico), .env.example marcados, PluginGallery huérfano.
- Workspaces (repo-scan): unión de dependencies/dev/peer/optional de TODOS los package.json del árbol + registro de nombres de paquetes internos (manifest.workspaceNames) — los imports de @devdeck/* ya no son fantasmas y el auto-import de paquetes internos tampoco.
- Aliases anidados: se pliegan los paths de TODOS los tsconfig/jsconfig (raíz y subpaquetes), resueltos relativos al directorio de cada config; resolveAliasTarget prueba todos los candidatos y gana el primero que resuelve (mismo prefijo en dos paquetes con destinos distintos no se confunde). Un import resuelto por alias TAMBIÉN cuenta como uso del paquete (workspace:* vía paths) — sin esto @devdeck/* aparecía "sin uso".
- Secretos: allowlist de credenciales canónicas de docs (AKIAIOSFODNN7EXAMPLE, secret key de AWS, ghp_ de docs de GitHub); contexto ±5 líneas con fake/ejemplo/demo → degrada a low; path de test/fixture/spec → degrada a low (nota en la explicación). El fixture propio usaba la key canónica de AWS como plantado: actualizada a una key realista.
- .env.example/.sample/.template/.defaults no se marcan como commiteados (hechos para commitearse); los .env reales siguen.
- Blob de menciones de deps sin uso ya no incluye package.json (nombran todas sus deps).
- dev_deck después: 63/100 CASI LISTO — 0 fantasmas, 2 "sin uso" plausibles (modern-web-guidance, highlight.js), 1 huérfano REAL (PluginGallery.tsx: solo lo menciona un comentario que dice que fue reemplazado por IntegrationsList), 3 .env reales commiteados (backend, apps/web, apps/desktop — hallazgo genuino de higiene).
- Tests: +6 (workspace deps, alias anidado bidireccional, alias anidado roto, .env de ejemplo, key canónica, degradación fake/test). 142 tests, tsc/eslint/build limpios.

Stage Summary:
- VibeCheck entiende monorepos: manifiesto = unión del árbol, aliases por paquete con resolución relativa, y paquetes internos usados vía paths cuentan como usados. Los secretos de demo (canónicos o declarados fake) ya no clavan el score en crítico. El reporte de dev_deck pasó de "PELIGRO por errores de la herramienta" a "CASI LISTO con hallazgos reales": 3 .env commiteados, PluginGallery muerto y 2 deps sin uso por verificar.

---
Task ID: 13
Agent: ZCode (GLM)
Task: Las 3 sugerencias de producto del review externo del reporte viejo de dev_deck — evidencia, severidad y doble conteo. (Aclaración: el reporte que analiza ya estaba arreglado en Task 12.)

Work Log:
- Doble conteo (verificado con código): los structural checks NO puntúan (solo informan); el score viene solo de hallazgos. dedupeFindings existía pero solo por título idéntico — "AWS Access Key" (scan) y "Credencial AWS expuesta" (IA) contaban dos veces. Fix: dropAiDuplicates en repo-score — un hallazgo IA con mismo archivo+categoría y líneas a ±2 de uno del scan se descarta (el scan es la fuente autoritativa y verificable; el crítico inflado de IA ya no puede clavar el techo duro por duplicación). Con scan sin líneas: dedupe conservador.
- Evidencia (punto A): los hallazgos de secretos ahora traen evidencia ENMASCARADA en la explicación (4 primeros + 6 puntos + 4 últimos chars) — el reporte permite ubicar y verificar el hallazgo sin filtrar el valor.
- Severidad (punto B): ya calibrada por diseño — degradaciones de demo/test/fixture (Task 12), scan con origen 'ai' marcado en UI/CLI, techos duros, y ahora el dedupe evita que la IA escale severidad duplicando un hallazgo del scan.
- Tests: +3 (dedupe doble conteo con score, dropAiDuplicates cerca/lejos, evidencia enmascarada). 145 tests, tsc/eslint/build limpios.

Stage Summary:
- Cada punto perdido tiene justificación defendible: sin doble conteo scan/IA, con evidencia enmascarada por hallazgo de secreto, y severidades que la herramienta misma degrada cuando el contexto dice "es un ejemplo". El benchmark formal recall/precision con ground truth queda como roadmap (el fixture plantado + 145 tests son el embrión).

---
Task ID: 7
Agent: ZCode (GLM)
Task: Falta re-auditar desde el detalle del reporte (el usuario lo pidió tras usar la app).

Work Log:
- page.tsx: extraído runRepoAudit(payload) de analyze() (resets + fetch NDJSON + toasts + historial + scroll); analyze() valida, construye el payload y delega. Nuevo estado repoAuditPayload: guarda el cuerpo exacto de la última auditoría interactiva y se reconstruye al cargar del historial (GitHub: https://github.com/repo/tree/branch + diff.base; carpetas → null porque los archivos subidos no se persisten).
- repo-report-view.tsx: prop onReaudit opcional → botón "Re-auditar" (RefreshCw) con tooltip explicando la caché; solo aparece cuando hay payload. "Auditar otro repo" queda como reset.
- Flujo de corrección completo: auditar → fix pack → corregir con el agente → Re-auditar (mismo objetivo; si no cambió nada sale de caché al instante, si cambió, auditoría fresca).
- Verificado en navegador con dev_deck cargado del historial: botón visible, clic (vía evaluate por los re-renders del hero), auditoría fresca en el historial "hace menos de un minuto". El usuario ya creó .z-ai-config: la síntesis de dev_deck sale de IA.

Stage Summary:
- Re-auditar cierra el ciclo auditar→corregir→re-auditar sin reescribir la URL ni re-soltar la carpeta. Carpeta desde historial no ofrece Re-auditar (honesto: los archivos no se guardan).
