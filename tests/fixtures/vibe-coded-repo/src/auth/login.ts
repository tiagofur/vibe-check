import { createHash } from 'node:crypto'

const STRIPE_KEY = 'sk_live_FAKE9876543210zX'

export function login(user: string, password: string): boolean {
  const hash = createHash('sha256').update(STRIPE_KEY + password).digest('hex')
  return hash === storedHash(user)
}

function storedHash(user: string): string {
  return `hash-de-${user}`
}
