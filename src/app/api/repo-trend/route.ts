import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * Serie temporal del Vibe Score de un repo (de más antiguo a más reciente).
 * Las auditorías en modo diff se excluyen: puntúan solo los cambios,
 * no el estado del repo completo.
 */
export async function GET(req: NextRequest) {
  const repoName = new URL(req.url).searchParams.get('repo')?.trim()
  if (!repoName) {
    return NextResponse.json({ error: 'Falta el parámetro ?repo=owner/name' }, { status: 400 })
  }

  try {
    const trend = await db.vibeRepoCheck.findMany({
      where: { repoName, isDiff: false },
      orderBy: { createdAt: 'asc' },
      select: {
        score: true,
        verdict: true,
        branch: true,
        source: true,
        createdAt: true,
      },
      take: 50,
    })
    return NextResponse.json({
      repo: repoName,
      trend: trend.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    })
  } catch (error) {
    console.error('[vibecheck] repo trend fetch failed:', error)
    return NextResponse.json({ error: 'Historial no disponible: no se pudo leer la base de datos' }, { status: 503 })
  }
}
