import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { RepoReport } from '@/lib/repo-types'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const check = await db.vibeRepoCheck.findUnique({ where: { id } })
    if (!check) {
      return NextResponse.json({ error: 'Auditoría no encontrada' }, { status: 404 })
    }
    const report = JSON.parse(check.report) as RepoReport
    return NextResponse.json({
      id: check.id,
      createdAt: check.createdAt.toISOString(),
      report,
    })
  } catch (error) {
    console.error('[vibecheck] fetch repo check failed:', error)
    return NextResponse.json({ error: 'Error al cargar la auditoría' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    await db.vibeRepoCheck.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'No se pudo eliminar' }, { status: 404 })
  }
}
