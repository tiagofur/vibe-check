# VibeCheck 🕵️

**Auditor adversarial de repositorios para la era del vibe coding.** ¿Ese repo lo escribió una IA a las 3 AM? Descúbrelo **antes de clonar**.

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748)](https://prisma.io)

VibeCheck audita repositorios completos (públicos de GitHub, carpetas locales o snippets) y produce un **Vibe Score 0-100** con veredicto: `SHIP IT 🚀` / `CASI LISTO 🟡` / `SOSPECHOSO 🤨` / `PELIGRO 🚨`.

A diferencia de los asistentes IA in-session (Claude Code, Cursor, Copilot), VibeCheck hace **due diligence independiente**: no escribió el código, así que no tiene incentivo para defenderlo.

## ¿Qué detecta?

| Categoría | Peso | Ejemplos |
|---|---|---|
| 🔒 Seguridad | 0.30 | Secretos hardcodeados, `.env` commiteado, inyección SQL/XSS, endpoints sin auth |
| 👻 Alucinaciones | 0.30 | Imports de paquetes que no existen, APIs inventadas, módulos locales que nunca se crearon, slopsquatting |
| 🐛 Bugs | 0.25 | Off-by-one, null sin manejar, race conditions, **tests falsos** (que no pueden fallar) |
| 🏭 Sobre-ingeniería | 0.15 | Abstracciones injustificadas, código muerto, deps sin uso, archivos huérfanos |

Además, un motor **determinista** (100% reproducible, cero LLM) verifica chequeos estructurales: grafo de imports vs. manifiesto, dependencias fantasma, imports rotos, secretos por patrón, `.env` commiteado, dependencias muertas y archivos que nadie importa.

## Cómo funciona

1. **Descarga + grafo de imports** — se recorre el árbol del repo (tarball de GitHub, sin API keys) y se construye el grafo de imports contra el manifiesto. Determinista y verificable.
2. **Triage adversarial** — los archivos se rankean por riesgo (auth > pagos > secretos > DB > API) y los ~30 más calientes se auditan con IA en lotes, cazando alucinaciones cross-file y tests falsos.
3. **Veredicto con evidencia** — hallazgos con archivo, línea y fix sugerido; señales de vibe coding; y un score determinista con **techo duro**: un crítico de seguridad o alucinación clava el score en ≤35 (PELIGRO).

## Empezar

Requisitos: [Bun](https://bun.sh) (o Node 20+), y credenciales de `z-ai-web-dev-sdk` para el backend de IA.

```bash
bun install

# Configura las variables de entorno
cp .env.example .env

# Crea la base de datos SQLite (historial de auditorías)
bun run db:generate && bun run db:push

# Arranca en http://localhost:3000
bun run dev
```

> El SDK de IA (`z-ai-web-dev-sdk`) se configura según su propia documentación (archivo `.z-ai-config`); nunca se usa en el cliente.

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor de desarrollo en :3000 |
| `bun run build` / `bun run start` | Build standalone de producción / arranque |
| `bun run lint` / `bun run typecheck` | ESLint / `tsc --noEmit` |
| `bun run db:push` / `db:generate` | Sincroniza el schema Prisma / regenera el cliente |

## API

| Endpoint | Descripción |
|---|---|
| `POST /api/analyze` | Audita un snippet (`{ code, language?, title? }`) |
| `POST /api/analyze-repo` | Audita un repo (`{ source: 'github', url }`) o carpeta (`{ source: 'files', files: [...] }`) |
| `GET /api/checks` · `GET /api/checks/[id]` · `DELETE` | Historial / detalle / borrado de snippets |
| `GET /api/repo-checks` · `GET /api/repo-checks/[id]` · `DELETE` | Historial / detalle / borrado de repos |

## Privacy by design

Los contenidos de los archivos auditados **nunca se persisten**: solo el reporte (scores, hallazgos, metadatos) queda en tu instancia. El código que pegas en el modo snippet tampoco se guarda.

## Límites conocidos

- Repos >40 MB comprimidos no soportados; se leen hasta 120 archivos por corrida (el grafo corre sobre el árbol completo).
- Repos privados requieren token — en el roadmap.
- Las auditorías IA pueden contener errores: **no sustituyen una code review humana**. Los hallazgos deterministas (`origin: scan`) sí son reproducibles.

## Roadmap

- [ ] GitHub Action: `vibecheck` como check de PR
- [ ] Badge SVG embebible (`/api/badge/owner/repo.svg`)
- [ ] OAuth para repos privados
- [ ] Modo diff: auditar solo lo nuevo desde un tag
- [ ] CLI (`npx vibecheck`)

## Contribuir

El mejor ejemplo de uso es auditar al propio auditor: clona, corre `bun run lint && bun run typecheck` y mira `src/lib/repo-scan.ts` — el motor determinista es puro y fácil de extender con nuevos chequeos.

## Licencia

[MIT](LICENSE) — hecho con 💚 para la comunidad dev.
