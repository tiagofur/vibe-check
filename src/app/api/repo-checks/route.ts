import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { RepoCheckHistoryItem, Verdict } from '@/lib/repo-types'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const checks = await db.vibeRepoCheck.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        repoName: true,
        source: true,
        branch: true,
        score: true,
        verdict: true,
        filesAudited: true,
        createdAt: true,
      },
    })

    const items: RepoCheckHistoryItem[] = checks.map((c) => ({
      id: c.id,
      repoName: c.repoName,
      source: c.source,
      branch: c.branch,
      score: c.score,
      verdict: c.verdict as Verdict,
      filesAudited: c.filesAudited,
      createdAt: c.createdAt.toISOString(),
    }))

    return NextResponse.json({ repoChecks: items })
  } catch (error) {
    console.error('[vibecheck] repo history fetch failed:', error)
    return NextResponse.json({ repoChecks: [] })
  }
}
