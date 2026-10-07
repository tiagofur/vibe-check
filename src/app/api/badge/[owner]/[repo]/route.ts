import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildBadgeSvg } from '@/lib/badge'

export const runtime = 'nodejs'

/**
 * Badge SVG con el último Vibe Score auditado para owner/repo.
 * Uso en READMEs:  ![VibeCheck](https://tu-instancia/api/badge/owner/repo.svg)
 * Nunca responde 404: sin auditoría previa devuelve un badge gris.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  const { owner, repo } = await params
  let score: number | null = null
  let previous: number | null = null
  try {
    const checks = await db.vibeRepoCheck.findMany({
      where: { repoName: `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`, source: 'github', isDiff: false },
      orderBy: { createdAt: 'desc' },
      select: { score: true },
      take: 2,
    })
    score = checks[0]?.score ?? null
    previous = checks[1]?.score ?? null
  } catch (error) {
    console.error('[vibecheck] badge lookup failed:', error)
    // sin BD: badge gris en vez de romper el README ajeno
  }

  return new NextResponse(buildBadgeSvg(score, previous), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
