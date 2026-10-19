import type { Config } from './config'
import type { ChatMessage, ModelBackend } from './domain'

export function parseModelJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(stripped)
}

/** POSTs body, with the configured chat model, to the endpoint's chat completions and returns the reply as JSON. */
export async function chatCompletion(config: Config, body: object, signal?: AbortSignal): Promise<any> {
  const key = config.apiKey
  if (!key) throw new Error('DEEPSEEK_API_KEY missing; start with `wick exec --only vllm -- bun run start`')
  const res = await fetch(`${config.vllmUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: config.chatModel, ...body }),
    signal,
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`vllm ${res.status}: ${detail}`)
  }
  return res.json()
}

function vllm(config: Config): ModelBackend {
  return {
    async complete(messages: ChatMessage[]) {
      const json = await chatCompletion(config, { response_format: { type: 'json_object' }, messages }, AbortSignal.timeout(180_000))
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('vllm reply has no message content')
      const usage = typeof json.usage?.prompt_tokens === 'number'
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens ?? 0,
            cachedTokens: json.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined
      return { json: parseModelJson(content), usage }
    },
  }
}

export const backends = { vllm } satisfies Record<string, (config: Config) => ModelBackend>
export type ModelBackendName = keyof typeof backends
