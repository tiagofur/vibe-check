import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { CheckHistoryItem, Verdict } from '@/lib/vibe-types'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const checks = await db.vibeCheck.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        language: true,
        score: true,
        verdict: true,
        createdAt: true,
      },
    })

    const items: CheckHistoryItem[] = checks.map((c) => ({
      id: c.id,
      title: c.title,
      language: c.language,
      score: c.score,
      verdict: c.verdict as Verdict,
      createdAt: c.createdAt.toISOString(),
    }))

    return NextResponse.json({ checks: items })
  } catch (error) {
    console.error('[vibecheck] history fetch failed:', error)
    return NextResponse.json({ error: 'Historial no disponible: no se pudo leer la base de datos' }, { status: 503 })
  }
}
