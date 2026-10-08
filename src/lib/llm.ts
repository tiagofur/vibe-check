// ─────────────────────────────────────────────────────────────
// VibeCheck · Cliente LLM multi-provider, cero dependencias
// Todos los endpoints hablan el dialecto OpenAI (chat completions),
// así que un solo adapter alcanza. Sin credenciales → getLLM()
// devuelve null y la app corre en modo determinista.
//
//   LLM_PROVIDER   gemini | openai | anthropic | openrouter | zai | ollama | none
//   LLM_MODEL      override global del modelo
//   LLM_BASE_URL   override del endpoint (proxies, Azure, gateways…)
//   + una API key por proveedor: GEMINI_API_KEY, OPENAI_API_KEY,
//     ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ZAI_API_KEY / ZHIPU_API_KEY
//     (Ollama no usa key: define OLLAMA_MODEL, opcionalmente OLLAMA_BASE_URL)
// ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmClient {
  /** gemini | openai | anthropic | openrouter | zai | ollama | zai-legacy */
  provider: string
  model: string
  /** Devuelve el texto de la respuesta; lanza ante error HTTP o respuesta vacía */
  complete(messages: ChatMessage[]): Promise<string>
}

interface ProviderSpec {
  name: string
  /** env vars cuya presencia activa el provider en modo auto (en orden) */
  keyEnv: string[]
  endpoint: string
  defaultModel: string
  /** override de modelo específico del provider */
  modelEnv?: string
  /** override de baseUrl específico del provider */
  baseUrlEnv?: string
  headers(apiKey: string): Record<string, string>
  /** GLM/Z.ai: apaga el thinking — el audit solo pide JSON */
  thinkingDisabled?: boolean
  /** Anthropic exige max_tokens incluso en el dialecto OpenAI */
  maxTokens?: number
}

// Defaults de entrada: el modelo barato/bueno de cada casa. Cualquiera se
// overridea con LLM_MODEL (o el modelEnv del provider).
const SPECS: ProviderSpec[] = [
  {
    name: 'gemini',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-2.5-flash',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    name: 'openrouter',
    keyEnv: ['OPENROUTER_API_KEY'],
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'google/gemini-2.5-flash',
    headers: (k) => ({
      Authorization: `Bearer ${k}`,
      'HTTP-Referer': 'https://github.com/tiagofur/vibe-check',
      'X-Title': 'VibeCheck',
    }),
  },
  {
    name: 'openai',
    keyEnv: ['OPENAI_API_KEY'],
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-5-mini',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    name: 'anthropic',
    keyEnv: ['ANTHROPIC_API_KEY'],
    endpoint: 'https://api.anthropic.com/v1/chat/completions',
    defaultModel: 'claude-haiku-4-5',
    maxTokens: 8192,
    headers: (k) => ({
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${k}`,
    }),
  },
  {
    name: 'zai',
    keyEnv: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
    endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',
    baseUrlEnv: 'ZAI_BASE_URL',
    defaultModel: 'glm-4.6',
    thinkingDisabled: true,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    name: 'ollama',
    keyEnv: [],
    endpoint: 'http://localhost:11434/v1/chat/completions',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    defaultModel: '',
    modelEnv: 'OLLAMA_MODEL',
    headers: () => ({}),
  },
]

export const PROVIDER_NAMES = SPECS.map((s) => s.name)

function firstEnv(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim()
    if (v) return v
  }
  return undefined
}

/** El primer assistant del SDK legacy era el system prompt: se normaliza */
function toWire(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages]
  if (out[0]?.role === 'assistant') out[0] = { role: 'system', content: out[0].content }
  return out
}

/** Construye la petición chat/completions (pura, testeable) */
export function buildChatRequest(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const baseUrl =
    process.env.LLM_BASE_URL?.trim() ||
    (spec.baseUrlEnv ? process.env[spec.baseUrlEnv]?.trim() : '') ||
    spec.endpoint
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...spec.headers(apiKey),
  }
  const body: Record<string, unknown> = { model, messages: toWire(messages) }
  if (spec.thinkingDisabled) body.thinking = { type: 'disabled' }
  if (spec.maxTokens) body.max_tokens = spec.maxTokens
  return { url: baseUrl, headers, body }
}

/** Extrae el texto de una respuesta chat/completions */
export function parseChatResponse(json: unknown): string {
  const content = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('La IA respondió sin contenido utilizable')
  }
  return content
}

function modelFor(spec: ProviderSpec): string {
  const model =
    process.env.LLM_MODEL?.trim() ||
    (spec.modelEnv ? process.env[spec.modelEnv]?.trim() : '') ||
    spec.defaultModel
  if (!model) {
    throw new Error(`LLM_PROVIDER=ollama requiere OLLAMA_MODEL (ej. "qwen2.5-coder:7b")`)
  }
  return model
}

function makeClient(spec: ProviderSpec, apiKey: string): LlmClient {
  const model = modelFor(spec)
  return {
    provider: spec.name,
    model,
    async complete(messages: ChatMessage[]): Promise<string> {
      const { url, headers, body } = buildChatRequest(spec, apiKey, model, messages)
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200)
        throw new Error(`${spec.name} respondió ${res.status}: ${detail}`)
      }
      return parseChatResponse(await res.json())
    },
  }
}

function specOf(name: string): ProviderSpec {
  const spec = SPECS.find((s) => s.name === name)
  if (!spec) {
    throw new Error(`LLM_PROVIDER="${name}" no es válido. Opciones: ${PROVIDER_NAMES.join(', ')}, none`)
  }
  return spec
}

export { specOf, type ProviderSpec }

/** Cliente por SDK legacy (sandboxes Z.ai con .z-ai-config): retrocompatible */
async function legacySdkClient(): Promise<LlmClient | null> {
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    return {
      provider: 'zai-legacy',
      model: 'glm (config del SDK)',
      async complete(messages: ChatMessage[]): Promise<string> {
        const completion = await zai.chat.completions.create({
          messages: toWire(messages),
          thinking: { type: 'disabled' },
        })
        return parseChatResponse(completion)
      },
    }
  } catch {
    return null
  }
}

/**
 * Resuelve el cliente de IA del entorno: LLM_PROVIDER explícito, o el
 * primer provider con credenciales (gemini → openrouter → openai →
 * anthropic → zai → ollama), o el SDK legacy de Z.ai. Null = sin IA.
 */
export async function getLLM(opts: { tryLegacySdk?: boolean } = {}): Promise<LlmClient | null> {
  const explicit = process.env.LLM_PROVIDER?.trim()
  if (explicit) {
    if (explicit === 'none') return null
    if (explicit !== 'auto') {
      const spec = specOf(explicit)
      const key = firstEnv(spec.keyEnv) ?? ''
      if (!key && spec.keyEnv.length > 0) {
        throw new Error(
          `LLM_PROVIDER=${spec.name} pero falta su API key (${spec.keyEnv.join(' o ')})`,
        )
      }
      return makeClient(spec, key)
    }
  }
  for (const spec of SPECS) {
    const key = firstEnv(spec.keyEnv)
    if (key || (spec.keyEnv.length === 0 && spec.modelEnv && process.env[spec.modelEnv]?.trim())) {
      return makeClient(spec, key ?? '')
    }
  }
  if (opts.tryLegacySdk === false) return null
  return legacySdkClient()
}
