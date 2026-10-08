import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // el fixture contiene tests falsos plantados a propósito: no son suites reales
    exclude: ['tests/fixtures/**', 'node_modules/**', 'dist/**'],
  },
})
