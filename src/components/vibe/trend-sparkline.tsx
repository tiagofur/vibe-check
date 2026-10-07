'use client'

import { scoreColor } from '@/lib/vibe-types'

/**
 * Sparkline SVG de la evolución del Vibe Score de un repo.
 * Puntos de más antiguo (izquierda) a más reciente (derecha);
 * cada punto se colorea según su score.
 */
export function TrendSparkline({ points }: { points: { score: number }[] }) {
  const w = 132
  const h = 40
  const pad = 5
  const n = points.length

  if (n < 2) return null

  const x = (i: number) => pad + (i / (n - 1)) * (w - 2 * pad)
  const y = (score: number) => h - pad - (Math.max(0, Math.min(100, score)) / 100) * (h - 2 * pad)
  const path = points
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pt.score).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Evolución del Vibe Score en ${n} auditorías`}
      className="shrink-0"
    >
      <line x1={pad} y1={y(80)} x2={w - pad} y2={y(80)} stroke="currentColor" className="text-emerald-500/25" strokeDasharray="3 3" strokeWidth="1" />
      <path d={path} fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
      {points.map((pt, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(pt.score)}
          r={i === n - 1 ? 3.2 : 2.2}
          fill={scoreColor(pt.score)}
          stroke="#09090b"
          strokeWidth="1"
        />
      ))}
    </svg>
  )
}
