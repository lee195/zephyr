import type { ChatMessage, ModelBackend } from './domain'

export function parseModelJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(stripped)
}

function vllm(env: Record<string, string | undefined>): ModelBackend {
  const base = env.ZEPHYR_VLLM_URL ?? 'https://llm.example.com/v1'
  const model = env.ZEPHYR_MODEL ?? 'deepseek-v4-flash-fast'
  return {
    async complete(messages: ChatMessage[]) {
      const key = env.DEEPSEEK_API_KEY
      if (!key) throw new Error('DEEPSEEK_API_KEY missing; start with `wick exec --only vllm -- bun run start`')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        throw new Error(`vllm ${res.status}: ${detail}`)
      }
      const json = (await res.json()) as any
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('vllm reply has no message content')
      return parseModelJson(content)
    },
  }
}

export const backends: Record<string, (env: Record<string, string | undefined>) => ModelBackend> = { vllm }
