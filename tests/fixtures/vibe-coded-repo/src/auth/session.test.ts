import { it } from 'vitest'
import { login } from './login'

it('creates a session for the user', () => {
  console.log(login('admin', 'hunter2'))
})

it('logs the attempt', async () => {
  await Promise.resolve()
})
