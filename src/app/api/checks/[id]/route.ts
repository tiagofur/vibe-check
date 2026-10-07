import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { VibeReport } from '@/lib/vibe-types'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const check = await db.vibeCheck.findUnique({ where: { id } })
    if (!check) {
      return NextResponse.json({ error: 'Auditoría no encontrada' }, { status: 404 })
    }
    const report = JSON.parse(check.report) as VibeReport
    return NextResponse.json({
      id: check.id,
      title: check.title,
      language: check.language,
      codeLines: check.codeLines,
      createdAt: check.createdAt.toISOString(),
      report,
    })
  } catch (error) {
    console.error('[vibecheck] fetch check failed:', error)
    return NextResponse.json({ error: 'Error al cargar la auditoría' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    await db.vibeCheck.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'No se pudo eliminar' }, { status: 404 })
  }
}
