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
  try {
    const check = await db.vibeRepoCheck.findFirst({
      where: { repoName: `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`, source: 'github' },
      orderBy: { createdAt: 'desc' },
      select: { score: true },
    })
    score = check?.score ?? null
  } catch (error) {
    console.error('[vibecheck] badge lookup failed:', error)
    // sin BD: badge gris en vez de romper el README ajeno
  }

  return new NextResponse(buildBadgeSvg(score), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
