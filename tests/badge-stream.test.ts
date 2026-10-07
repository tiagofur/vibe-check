import { describe, expect, it } from 'vitest'
import { buildBadgeSvg } from '../src/lib/badge'
import { parseRepoStreamLine } from '../src/lib/stream-client'

describe('buildBadgeSvg', () => {
  it('badge verde para scores altos y rojo para bajos', () => {
    const good = buildBadgeSvg(93)
    expect(good).toContain('93/100')
    expect(good).toContain('#10b981')
    expect(buildBadgeSvg(20)).toContain('#ef4444')
    expect(buildBadgeSvg(60)).toContain('#f59e0b')
    expect(buildBadgeSvg(40)).toContain('#f97316')
  })

  it('score fuera de rango se ajusta a 0-100', () => {
    expect(buildBadgeSvg(140)).toContain('100/100')
    expect(buildBadgeSvg(-5)).toContain('0/100')
  })

  it('sin auditoría previa devuelve badge gris "no auditado" (nunca 404)', () => {
    const svg = buildBadgeSvg(null)
    expect(svg).toContain('no auditado')
    expect(svg).toContain('#9ca3af')
    expect(svg).toContain('<svg')
  })

  it('con score previo añade la flecha de tendencia', () => {
    expect(buildBadgeSvg(98, 93)).toContain('↗')
    expect(buildBadgeSvg(80, 95)).toContain('↘')
    expect(buildBadgeSvg(90, 90)).toContain('→')
    // sin previo: sin flecha
    expect(buildBadgeSvg(98)).not.toContain('↗')
    expect(buildBadgeSvg(98)).not.toContain('↘')
  })
})

describe('parseRepoStreamLine', () => {
  it('parsea los tres tipos de evento', () => {
    expect(parseRepoStreamLine('{"type":"progress","phase":"ia","pct":40,"message":"lote 1"}')).toEqual({
      type: 'progress',
      phase: 'ia',
      pct: 40,
      message: 'lote 1',
    })
    expect(
      parseRepoStreamLine('{"type":"done","id":"abc","report":{"score":50},"cached":false}'),
    ).toMatchObject({ type: 'done' })
    expect(parseRepoStreamLine('{"type":"error","error":"boom"}')).toEqual({
      type: 'error',
      error: 'boom',
    })
  })

  it('devuelve null para líneas vacías, basura o JSON sin type', () => {
    expect(parseRepoStreamLine('')).toBeNull()
    expect(parseRepoStreamLine('   ')).toBeNull()
    expect(parseRepoStreamLine('no soy json')).toBeNull()
    expect(parseRepoStreamLine('{"foo":1}')).toBeNull()
  })
})
