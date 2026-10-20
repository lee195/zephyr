import type { Config, Endpoint } from './config'
import type { ChatMessage, ModelBackend } from './domain'

export function parseModelJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(stripped)
}

/** How long one model call may take. */
export const CALL_TIMEOUT_MS = 180_000

function chatEndpoint(config: Config): Endpoint {
  if (!config.chat) throw new Error('the vllm backend needs ZEPHYR_CHAT_URL, ZEPHYR_CHAT_MODEL and ZEPHYR_CHAT_KEY_VAR')
  return config.chat
}

/** POSTs body, with the configured chat model, to the chat endpoint's completions and returns the reply as JSON. */
export async function chatCompletion(config: Config, body: object, signal?: AbortSignal): Promise<any> {
  const chat = chatEndpoint(config)
  if (!chat.apiKey) throw new Error(`${chat.keyVar} missing; for the shared endpoint, start with \`wick exec --only vllm -- bun run start\``)
  const res = await fetch(`${chat.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${chat.apiKey}` },
    body: JSON.stringify({ model: chat.model, ...body }),
    signal,
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`chat endpoint ${res.status}: ${detail}`)
  }
  return res.json()
}

/** Any OpenAI-compatible chat endpoint; named for the vLLM endpoint it was first built for. */
function vllm(config: Config): ModelBackend {
  chatEndpoint(config)
  return {
    async complete(messages: ChatMessage[]) {
      const json = await chatCompletion(config, { response_format: { type: 'json_object' }, messages }, AbortSignal.timeout(CALL_TIMEOUT_MS))
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('chat endpoint reply has no message content')
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
