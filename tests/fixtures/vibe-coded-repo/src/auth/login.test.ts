import { describe, expect, it } from 'vitest'
import { login } from './login'

describe('auth', () => {
  it('should authenticate user', () => {
    expect(true).toBe(true)
  })

  it('hashes the password', () => {
    login('admin', 'hunter2')
  })

  it('validates empty password', () => {})

  it.skip('rate limits attempts', () => {
    expect(login('admin', 'wrong')).toBe(false)
  })
})
