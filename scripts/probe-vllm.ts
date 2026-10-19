import { parseConfig } from '../src/config'

const { vllmUrl: BASE, chatModel: MODEL, apiKey: key } = parseConfig(process.env)
if (!key) throw new Error('DEEPSEEK_API_KEY missing; run with bun --env-file=.env.local')

const entries = [
  { id: 'e1', text: 'Kickoff with the Wick team, decided to retire the token vault idea' },
  { id: 'e2', text: 'Bread: try 75% hydration and a longer cold proof' },
  { id: 'e3', text: '1Password owns storage now; we only build the wizard' },
]

const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You organize notes into topic pages. Reply with JSON only: {"upserts":[{"slug":string,"title":string,"sources":string[],"body":string}]}. sources are entry ids. body is markdown.',
      },
      { role: 'user', content: JSON.stringify({ entries }) },
    ],
  }),
})
const json = (await res.json()) as any
const content: string = json.choices?.[0]?.message?.content ?? ''
const parsed = JSON.parse(content.replace(/^```(json)?\s*|\s*```$/g, ''))
const ok =
  Array.isArray(parsed.upserts) &&
  parsed.upserts.every((u: any) => typeof u.slug === 'string' && Array.isArray(u.sources) && typeof u.body === 'string')
console.log(JSON.stringify({ status: res.status, model: MODEL, ok, topics: parsed.upserts?.map((u: any) => [u.slug, u.sources]), usage: json.usage }, null, 2))
if (!ok) process.exit(1)
