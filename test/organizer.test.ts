import { expect, test } from 'bun:test'
import { kinds } from '../src/kinds'

const organizer = kinds.organizer!
const known = new Set(['e1', 'e2'])

test('a good reply yields sanitized upserts', () => {
  const result = organizer.validate(
    { upserts: [{ slug: 'Bread Baking!', title: 'Bread', sources: ['e1'], body: '# Bread' }] },
    known,
  )
  expect(result).toEqual({ ok: true, upserts: [{ slug: 'bread-baking', title: 'Bread', sources: ['e1'], body: '# Bread' }] })
})

test('malformed replies fail', () => {
  expect(organizer.validate({ topics: [] }, known).ok).toBe(false)
  expect(organizer.validate({ upserts: [{ slug: 'a', sources: ['e1'], body: 7 }] }, known).ok).toBe(false)
  expect(organizer.validate({ upserts: [{ slug: 'a', sources: 'e1', body: 'x' }] }, known).ok).toBe(false)
  expect(organizer.validate({ upserts: [{ slug: '!!!', sources: ['e1'], body: 'x' }] }, known).ok).toBe(false)
  expect(organizer.validate(null, known).ok).toBe(false)
})

test('unknown source ids are dropped, and a topic left with none is dropped', () => {
  const result = organizer.validate(
    {
      upserts: [
        { slug: 'a', title: 'A', sources: ['e1', 'ghost', 'e1'], body: 'x' },
        { slug: 'b', title: 'B', sources: ['ghost'], body: 'y' },
      ],
    },
    known,
  )
  expect(result).toEqual({ ok: true, upserts: [{ slug: 'a', title: 'A', sources: ['e1'], body: 'x' }] })
})

test('the prompt carries new entries, existing topics, and context', () => {
  const entry = (id: string, text: string) => ({ id, harness: 'claude-code', sessionId: 's', at: 't', text })
  const view = { id: 'organizer/a', kind: 'organizer', slug: 'a', title: 'A', sources: ['e1'], format: 'md' as const, body: 'old', updatedAt: 't' }
  const messages = organizer.buildMessages([entry('e2', 'new thing')], [view], [entry('e1', 'old thing')])
  const user = JSON.parse(messages.at(-1)!.content)
  expect(user.newEntries.map((e: any) => e.id)).toEqual(['e2'])
  expect(user.recentEntries.map((e: any) => e.id)).toEqual(['e1'])
  expect(user.existingTopics[0].slug).toBe('a')
})
