import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildChatRequest,
  getLLM,
  parseChatResponse,
  PROVIDER_NAMES,
  specOf,
  type ChatMessage,
} from '../src/lib/llm'

// ── Manejo de env: limpiar y restaurar las variables de IA ──────
const LLM_ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
  'ZAI_BASE_URL',
  'OLLAMA_MODEL',
  'OLLAMA_BASE_URL',
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(LLM_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of LLM_ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of LLM_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const messages: ChatMessage[] = [
  { role: 'assistant', content: 'SYSTEM PROMPT' },
  { role: 'user', content: 'hola' },
]

describe('buildChatRequest · wire format OpenAI-compatible', () => {
  it('gemini: endpoint correcto, system normalizado y Bearer auth', () => {
    const req = buildChatRequest(specOf('gemini'), 'key-g', 'gemini-3.8-flash', messages)
    expect(req.url).toContain('generativelanguage.googleapis.com')
    expect(req.headers.Authorization).toBe('Bearer key-g')
    expect(req.body.model).toBe('gemini-3.8-flash')
    // el primer mensaje 'assistant' del SDK legacy viaja como 'system'
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'hola' },
    ])
    // thinking/max_tokens son exclusivos de otros providers
    expect(req.body.thinking).toBeUndefined()
    expect(req.body.max_tokens).toBeUndefined()
  })

  it('zai (GLM): manda thinking disabled y respeta ZAI_BASE_URL', () => {
    process.env.ZAI_BASE_URL = 'https://mi-proxy.ejemplo.com/v4/chat/completions'
    const req = buildChatRequest(specOf('zai'), 'key-z', 'glm-5.3-flash', messages)
    expect(req.body.thinking).toEqual({ type: 'disabled' })
    expect(req.url).toBe('https://mi-proxy.ejemplo.com/v4/chat/completions')
  })

  it('anthropic: headers x-api-key + anthropic-version y max_tokens obligatorio', () => {
    const req = buildChatRequest(specOf('anthropic'), 'key-a', 'claude-haiku-5.5', messages)
    expect(req.url).toContain('api.anthropic.com')
    expect(req.headers['x-api-key']).toBe('key-a')
    expect(req.headers['anthropic-version']).toBeTruthy()
    expect(req.body.max_tokens).toBeGreaterThan(0)
  })

  it('openrouter: attribution headers presentes', () => {
    const req = buildChatRequest(specOf('openrouter'), 'key-o', 'openrouter/free', messages)
    expect(req.url).toContain('openrouter.ai')
    expect(req.headers['X-Title']).toBeTruthy()
    expect(req.headers['HTTP-Referer']).toBeTruthy()
  })

  it('LLM_BASE_URL global overridea el endpoint de cualquier provider', () => {
    process.env.LLM_BASE_URL = 'https://gateway.interno/v1/chat/completions'
    const req = buildChatRequest(specOf('openai'), 'k', 'gpt-6-luna', messages)
    expect(req.url).toBe('https://gateway.interno/v1/chat/completions')
  })

  it('todos los providers conocidos construyen peticiones sin lanzar', () => {
    for (const name of PROVIDER_NAMES) {
      const req = buildChatRequest(specOf(name), 'k', 'modelo', messages)
      expect(req.body.model).toBe('modelo')
    }
  })
})

describe('parseChatResponse', () => {
  it('extrae el contenido del primer choice', () => {
    expect(parseChatResponse({ choices: [{ message: { content: '{"findings":[]}' } }] })).toBe(
      '{"findings":[]}',
    )
  })
  it('lanza con respuesta vacía o malformada', () => {
    expect(() => parseChatResponse({ choices: [] })).toThrow()
    expect(() => parseChatResponse({ choices: [{ message: { content: '' } }] })).toThrow()
    expect(() => parseChatResponse({})).toThrow()
  })
})

describe('getLLM · selección de provider por entorno', () => {
  it('auto-detecta en orden: gemini gana si hay varias keys', async () => {
    process.env.GEMINI_API_KEY = 'g'
    process.env.OPENAI_API_KEY = 'o'
    const llm = await getLLM({ tryLegacySdk: false })
    expect(llm?.provider).toBe('gemini')
    expect(llm?.model).toBe('gemini-3.8-flash')
  })

  it('cada provider con su sola key es seleccionable', async () => {
    process.env.OPENAI_API_KEY = 'o'
    expect((await getLLM({ tryLegacySdk: false }))?.provider).toBe('openai')
    delete process.env.OPENAI_API_KEY

    process.env.ANTHROPIC_API_KEY = 'a'
    expect((await getLLM({ tryLegacySdk: false }))?.provider).toBe('anthropic')
    delete process.env.ANTHROPIC_API_KEY

    process.env.OPENROUTER_API_KEY = 'or'
    expect((await getLLM({ tryLegacySdk: false }))?.provider).toBe('openrouter')
    delete process.env.OPENROUTER_API_KEY

    process.env.ZAI_API_KEY = 'z'
    expect((await getLLM({ tryLegacySdk: false }))?.provider).toBe('zai')
    delete process.env.ZAI_API_KEY
  })

  it('ollama se activa con OLLAMA_MODEL aunque no use key', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5-coder:7b'
    const llm = await getLLM({ tryLegacySdk: false })
    expect(llm?.provider).toBe('ollama')
    expect(llm?.model).toBe('qwen2.5-coder:7b')
  })

  it('sin credenciales devuelve null (modo determinista)', async () => {
    expect(await getLLM({ tryLegacySdk: false })).toBeNull()
  })

  it('LLM_PROVIDER explícito gana sobre el orden de auto-detección', async () => {
    process.env.LLM_PROVIDER = 'openai'
    process.env.GEMINI_API_KEY = 'g'
    process.env.OPENAI_API_KEY = 'o'
    expect((await getLLM({ tryLegacySdk: false }))?.provider).toBe('openai')
  })

  it('LLM_PROVIDER=none apaga la IA aunque haya keys', async () => {
    process.env.LLM_PROVIDER = 'none'
    process.env.GEMINI_API_KEY = 'g'
    expect(await getLLM({ tryLegacySdk: false })).toBeNull()
  })

  it('LLM_PROVIDER inválido lanza con las opciones válidas', async () => {
    process.env.LLM_PROVIDER = 'chuck-norris'
    await expect(getLLM({ tryLegacySdk: false })).rejects.toThrow(/gemini/)
  })

  it('LLM_PROVIDER sin su key lanza mensaje accionable', async () => {
    process.env.LLM_PROVIDER = 'anthropic'
    await expect(getLLM({ tryLegacySdk: false })).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it('ollama sin OLLAMA_MODEL lanza en vez de adivinar', async () => {
    process.env.LLM_PROVIDER = 'ollama'
    await expect(getLLM({ tryLegacySdk: false })).rejects.toThrow(/OLLAMA_MODEL/)
  })

  it('LLM_MODEL overridea el default del provider', async () => {
    process.env.GEMINI_API_KEY = 'g'
    process.env.LLM_MODEL = 'gemini-3.5-flash-lite'
    const llm = await getLLM({ tryLegacySdk: false })
    expect(llm?.model).toBe('gemini-3.5-flash-lite')
  })
})
