// ─────────────────────────────────────────────────────────────
// VibeCheck · Rate limiting en memoria (ventana fija por clave)
// Suficiente para instancias single-node; para multi-instancia
// sustituir por Redis. Las cuotas quemadas son de LLM: se defiende
// antes de cualquier trabajo pesado.
// ─────────────────────────────────────────────────────────────

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 1000

export interface RateLimitResult {
  ok: boolean
  /** Segundos hasta que la ventana se reinicie (para Retry-After) */
  retryAfterSec: number
  /** Cuota restante en la ventana actual */
  remaining: number
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()

  // Purga oportunista para no crecer sin límite
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k)
    }
  }

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSec: 0, remaining: limit - 1 }
  }

  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), remaining: 0 }
  }

  bucket.count++
  return { ok: true, retryAfterSec: 0, remaining: limit - bucket.count }
}

/** IP del cliente (detrás de proxy) o clave anónima para dev local */
export function clientKeyFrom(req: { headers: Headers }): string {
  const fwd = req.headers.get('x-forwarded-for')
  const ip = fwd?.split(',')[0]?.trim()
  return ip || 'local'
}

export function resetRateLimits(): void {
  buckets.clear()
}
