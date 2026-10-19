import { expect, test } from 'bun:test'
import { organizerMessages, validateOps, type ReplyContext } from '../src/kinds/organizer'
import { entry, payloadOf } from './helpers'

const organizer = { validate: validateOps, buildMessages: organizerMessages }
const ctx: ReplyContext = { knownIds: new Set(['e1', 'e2']), existingSlugs: new Set(), openSlugs: new Set() }

test('a good reply yields sanitized ops', () => {
  const result = organizer.validate({ ops: [{ op: 'write', slug: 'Bread Baking!', title: 'Bread', sources: ['e1'], body: 'Rye needs time.' }] }, ctx)
  expect(result).toEqual({ ok: true, ops: [{ op: 'write', slug: 'bread-baking', title: 'Bread', sources: ['e1'], body: 'Rye needs time.' }], dropped: [] })
})

const bodyFor = (title: string, body: string) => {
  const result = organizer.validate({ ops: [{ op: 'write', slug: 'q3', title, sources: ['e1'], body }] }, ctx)
  if (!result.ok) throw new Error(result.error)
  return result.ops[0]!.body
}

test('a leading heading that repeats the title is stripped from the body', () => {
  expect(bodyFor('Q3 Roadmap', '# Q3 Roadmap\n\nShip the viewer.')).toBe('Ship the viewer.')
  expect(bodyFor('Q3 Roadmap', '\n  ### q3 roadmap  \n- ship')).toBe('- ship')
  expect(bodyFor(' Q3 Roadmap ', '## Q3 Roadmap ##\nShip.')).toBe('Ship.')
})

test('a heading that differs from the title, or no heading, leaves the body as is', () => {
  expect(bodyFor('Q3 Roadmap', '# Q3 Risks\n\nHiring.')).toBe('# Q3 Risks\n\nHiring.')
  expect(bodyFor('Q3 Roadmap', 'Q3 Roadmap is on track.\n# Q3 Roadmap')).toBe('Q3 Roadmap is on track.\n# Q3 Roadmap')
  expect(bodyFor('Q3 Roadmap', '#Q3 Roadmap')).toBe('#Q3 Roadmap')
})

test('malformed replies fail', () => {
  expect(organizer.validate({ upserts: [] }, ctx).ok).toBe(false)
  expect(organizer.validate({ ops: [{ op: 'upsert', slug: 'a', sources: ['e1'], body: 'x' }] }, ctx).ok).toBe(false)
  expect(organizer.validate({ ops: [{ op: 'write', slug: 'a', sources: ['e1'], body: 7 }] }, ctx).ok).toBe(false)
  expect(organizer.validate({ ops: [{ op: 'append', slug: 'a', sources: 'e1', body: 'x' }] }, ctx).ok).toBe(false)
  expect(organizer.validate({ ops: [{ op: 'write', slug: '!!!', sources: ['e1'], body: 'x' }] }, ctx).ok).toBe(false)
  expect(organizer.validate(null, ctx).ok).toBe(false)
})

test('unknown source ids are dropped, and an op left with none is dropped with a reason', () => {
  const result = organizer.validate(
    {
      ops: [
        { op: 'write', slug: 'a', title: 'A', sources: ['e1', 'ghost', 'e1'], body: 'x' },
        { op: 'write', slug: 'b', title: 'B', sources: ['ghost'], body: 'y' },
      ],
    },
    ctx,
  )
  expect(result).toEqual({ ok: true, ops: [{ op: 'write', slug: 'a', title: 'A', sources: ['e1'], body: 'x' }], dropped: ['write b: no known sources'] })
})

test('a topic written earlier in the same reply can be appended to', () => {
  const result = organizer.validate(
    {
      ops: [
        { op: 'write', slug: 'new', title: 'New', sources: ['e1'], body: 'x' },
        { op: 'append', slug: 'new', sources: ['e2'], body: 'y' },
      ],
    },
    ctx,
  )
  expect(result.ok && result.ops.map((o) => o.op)).toEqual(['write', 'append'])
})

test('the prompt shows open topics in full and every other topic as one index line', () => {
  const view = (slug: string, body: string, sources: string[]) => ({ id: `organizer/${slug}`, kind: 'organizer', slug, title: slug.toUpperCase(), sources, format: 'md' as const, body, updatedAt: 't' })
  const messages = organizer.buildMessages(
    [entry('e3', 'new thing')],
    { open: [view('a', 'open body', ['e1'])], indexed: [view('b', 'hidden body', ['e1', 'e2'])] },
    [entry('e1', 'old thing')],
  )
  const user = JSON.parse(messages.at(-1)!.content)
  expect(user.newEntries.map((e: any) => e.id)).toEqual(['e3'])
  expect(user.recentEntries.map((e: any) => e.id)).toEqual(['e1'])
  expect(user.openTopics).toEqual([{ slug: 'a', title: 'A', body: 'open body' }])
  expect(user.topicIndex).toEqual(['b | B | 2 sources'])
  expect(messages.map((m) => m.content).join('\n')).not.toContain('hidden body')
})

test('the prompt offers append an optional title and shows every topic its current title', () => {
  const view = (slug: string, title: string) => ({ id: `organizer/${slug}`, kind: 'organizer', slug, title, sources: ['e1'], format: 'md' as const, body: 'x', updatedAt: 't' })
  const messages = organizer.buildMessages([entry('e2', 'new')], { open: [view('a', 'Open Title')], indexed: [view('b', 'Indexed Title')] }, [])
  const system = messages[0]!.content
  expect(system).toContain('{"op":"append","slug":string,"title"?:string,')
  expect(system).toMatch(/append.*title.*no longer describes/i)
  const user = payloadOf(messages)
  expect(user.openTopics[0].title).toBe('Open Title')
  expect(user.topicIndex).toEqual(['b | Indexed Title | 1 sources'])
})
