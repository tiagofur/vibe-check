import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'cli.ts')
const FIXTURE = join(ROOT, 'tests/fixtures/vibe-coded-repo')

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync('bun', [CLI, FIXTURE, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
}

// El mock corre en un PROCESO aparte: si viviera en este worker, spawnSync
// bloquearía el event loop y el fetch del CLI nunca recibiría respuesta.
const mockChildren: ChildProcess[] = []
let baseUrl = ''
let failUrl = ''

function spawnMock(response: 'ok' | 'fail'): Promise<string> {
  const script =
    response === 'ok'
      ? `
    const { createServer } = require('node:http')
    const body = JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            findings: [{
              file: 'src/billing/pagos.ts',
              lines: [3],
              severity: 'high',
              category: 'bugs',
              title: 'HALLAZGO-MOCK-IA',
              explanation: 'plantado por el test',
              fix: 'revisar',
            }],
          }),
        },
      }],
    })
    const s = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
      })
    })
    s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port))
  `
      : `
    const { createServer } = require('node:http')
    const s = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream saturado' }))
      })
    })
    s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port))
  `
  const child = spawn(process.execPath, ['-e', script])
  mockChildren.push(child)
  return new Promise<string>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      const m = String(d).match(/PORT (\d+)/)
      if (m) resolve(`http://127.0.0.1:${m[1]}/v1/chat/completions`)
    })
    child.on('exit', (code) => reject(new Error(`el mock LLM murió (${code})`)))
    setTimeout(() => reject(new Error('el mock LLM no levantó')), 10_000)
  })
}

beforeAll(async () => {
  baseUrl = await spawnMock('ok')
  failUrl = await spawnMock('fail')
}, 20_000)

afterAll(() => {
  for (const c of mockChildren) c.kill()
})

describe('cli.ts --ai', () => {
  it('sin credenciales cae al determinista con aviso honesto', () => {
    const r = runCli(['--ai', '--json'], { LLM_PROVIDER: 'none' })
    expect(r.status).toBe(1) // el fixture tiene defectos plantados
    expect(r.stderr).toContain('--ai pedida pero no hay credenciales')
    expect(r.stdout).toContain('"mode": "determinista (sin IA)"')
    expect(r.stdout).not.toContain('HALLAZGO-MOCK-IA')
  })

  it('con credenciales ejecuta la auditoría IA end-to-end contra el endpoint configurado', () => {
    const r = runCli(['--ai'], {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      LLM_BASE_URL: baseUrl,
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('auditoría con IA (openai · gpt-6-luna)')
    expect(r.stdout).toContain('HALLAZGO-MOCK-IA') // el hallazgo del mock viajó ida y vuelta
    expect(r.stdout).toContain('🤖 IA')
    expect(r.stdout).toContain('🤖 Resumen (IA):')
  })

  it('--ai --json incluye el bloque ai y el summary', () => {
    const r = runCli(['--ai', '--json'], {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      LLM_BASE_URL: baseUrl,
    })
    expect(r.status).toBe(1)
    const out = JSON.parse(r.stdout)
    expect(out.mode).toContain('ia (openai')
    expect(out.ai.provider).toBe('openai')
    expect(out.ai.filesAudited).toBeGreaterThan(0)
    expect(out.ai.findings).toBeGreaterThan(0)
    expect(out.summary).toBeTruthy()
  })

  it('si el endpoint de IA falla, avisa por lote y no se lo calla', () => {
    const r = runCli(['--ai'], {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      LLM_BASE_URL: failUrl,
    })
    // el fixture igual puntúa por el escaneo determinista
    expect(r.status).toBe(1)
    // stderr (no el reporte): cada lote fallido avisado con el error real
    expect(r.stderr).toContain('lote de IA falló')
    expect(r.stderr).toContain('respondió 500')
    expect(r.stderr).toContain('Los 1 lotes de IA fallaron')
    // el hallazgo del mock bueno NO aparece (nunca hubo IA exitosa)
    expect(r.stdout).not.toContain('HALLAZGO-MOCK-IA')
  })
})
