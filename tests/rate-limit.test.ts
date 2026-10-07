import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientKeyFrom, rateLimit, resetRateLimits } from '../src/lib/rate-limit'

beforeEach(() => resetRateLimits())
afterEach(() => vi.useRealTimers())

describe('rateLimit', () => {
  it('permite hasta el límite y luego bloquea con Retry-After', () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit('k', 5, 60_000).ok).toBe(true)
    }
    const blocked = rateLimit('k', 5, 60_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60)
  })

  it('reinicia la ventana al pasar el tiempo', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 3; i++) expect(rateLimit('k', 3, 1000).ok).toBe(true)
    expect(rateLimit('k', 3, 1000).ok).toBe(false)
    vi.advanceTimersByTime(1001)
    const after = rateLimit('k', 3, 1000)
    expect(after.ok).toBe(true)
    expect(after.remaining).toBe(2)
  })

  it('claves distintas no comparten cuota', () => {
    for (let i = 0; i < 3; i++) expect(rateLimit('a', 3, 60_000).ok).toBe(true)
    expect(rateLimit('a', 3, 60_000).ok).toBe(false)
    expect(rateLimit('b', 3, 60_000).ok).toBe(true)
  })

  it('clientKeyFrom prefiere x-forwarded-for y cae a local', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })
    expect(clientKeyFrom({ headers })).toBe('203.0.113.7')
    expect(clientKeyFrom({ headers: new Headers() })).toBe('local')
  })
})
