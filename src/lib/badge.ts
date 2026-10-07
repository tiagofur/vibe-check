// ─────────────────────────────────────────────────────────────
// VibeCheck · Generador de badges SVG estilo shields.io
// Sin dependencias: un string con el score y color de veredicto.
// Con score previo muestra la flecha de tendencia (↗ ↘ →).
// ─────────────────────────────────────────────────────────────

import { computeTrend, trendArrow } from './trend'
import { verdictFromScore } from './vibe-types'

const LABEL_COLOR = '#555'
const UNKNOWN_COLOR = '#9ca3af'

function scoreColor(score: number): string {
  if (score >= 80) return '#10b981'
  if (score >= 60) return '#f59e0b'
  if (score >= 40) return '#f97316'
  return '#ef4444'
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Ancho aproximado del texto a 11px Verdana (para dimensionar el shield) */
function textWidth(s: string): number {
  return Math.round(6.5 * s.length + 8)
}

function shield(label: string, value: string, valueColor: string): string {
  const labelW = textWidth(label)
  const valueW = textWidth(value)
  const totalW = labelW + valueW
  const labelX = Math.round(labelW / 2)
  const valueX = labelW + Math.round(valueW / 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="${LABEL_COLOR}"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${valueColor}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="14">${esc(label)}</text>
    <text x="${valueX}" y="14">${esc(value)}</text>
  </g>
</svg>`
}

/**
 * Badge del último Vibe Score auditado para un repo.
 * `score = null` → badge gris "no auditado" (los badges nunca deben 404).
 * `previous` (score de la auditoría anterior, si existe) añade la flecha de tendencia.
 */
export function buildBadgeSvg(score: number | null, previous?: number | null): string {
  if (score === null || Number.isNaN(score)) {
    return shield('vibe check', 'no auditado', UNKNOWN_COLOR)
  }
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  let value = `${clamped}/100`
  if (typeof previous === 'number' && !Number.isNaN(previous)) {
    value += ` ${trendArrow(computeTrend([p(previous), p(clamped)]).direction)}`
  }
  return shield('vibe score', value, scoreColor(clamped))
}

const p = (score: number) => ({ score, createdAt: 'x' })

/** Emoji del veredicto para mensajes (misma escala que la UI) */
export function verdictEmoji(score: number): string {
  const verdict = verdictFromScore(Math.max(0, Math.min(100, score)))
  return { 'SHIP IT': '🚀', 'CASI LISTO': '🟡', SOSPECHOSO: '🤨', PELIGRO: '🚨' }[verdict]
}
