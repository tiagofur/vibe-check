'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

// Longitud del arco semicircular con r=90 → π·90
const ARC_LENGTH = Math.PI * 90

export function ScoreGauge({ score, size = 220 }: { score: number; size?: number }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 150)
    return () => clearTimeout(t)
  }, [])

  const offset = ARC_LENGTH * (1 - Math.min(100, Math.max(0, score)) / 100)

  return (
    <div className="relative flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 220 128" width={size} height={size * 0.58} role="img" aria-label={`Vibe Score: ${score} de 100`}>
        <defs>
          <linearGradient id="vibe-arc-gradient" x1="0%" y1="100%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="40%" stopColor="#f97316" />
            <stop offset="60%" stopColor="#f59e0b" />
            <stop offset="85%" stopColor="#10b981" />
            <stop offset="100%" stopColor="#34d399" />
          </linearGradient>
        </defs>
        {/* Track */}
        <path
          d="M 20 110 A 90 90 0 0 1 200 110"
          fill="none"
          stroke="currentColor"
          className="text-muted-foreground"
          strokeWidth="14"
          strokeLinecap="round"
          opacity={0.2}
        />
        {/* Progress */}
        <motion.path
          d="M 20 110 A 90 90 0 0 1 200 110"
          fill="none"
          stroke="url(#vibe-arc-gradient)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={ARC_LENGTH}
          initial={{ strokeDashoffset: ARC_LENGTH }}
          animate={{ strokeDashoffset: mounted ? offset : ARC_LENGTH }}
          transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
        />
        <text
          x="110"
          y="92"
          textAnchor="middle"
          className="fill-foreground font-mono"
          fontSize="44"
          fontWeight="700"
        >
          {score}
        </text>
        <text x="110" y="114" textAnchor="middle" className="fill-muted-foreground" fontSize="13">
          / 100
        </text>
      </svg>
    </div>
  )
}

export function MiniRing({
  score,
  size = 44,
  stroke = 5,
  className,
}: {
  score: number
  size?: number
  stroke?: number
  className?: string
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 200)
    return () => clearTimeout(t)
  }, [])

  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.min(100, Math.max(0, score)) / 100)
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : score >= 40 ? '#f97316' : '#ef4444'

  return (
    <svg width={size} height={size} className={cn('shrink-0 -rotate-90', className)} aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-zinc-700"
        opacity={0.4}
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: mounted ? offset : c }}
        transition={{ duration: 1, ease: 'easeOut' }}
      />
    </svg>
  )
}
