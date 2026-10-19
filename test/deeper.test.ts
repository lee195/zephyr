import { expect, test } from 'bun:test'
import { withMcp } from './desk'

const text = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text)

/** A server whose last review closed after garden, compost and trip were filed; garden and trip then got a note each, and big was made over the rewrite cap. */
async function reviewedThenNoted() {
  const s = await withMcp()
  await s.note('garden: beans', 'compost: worms', 'trip: train')
  await s.call('finish_review', { until: text(await s.call('get_review')).until })
  await s.note('garden: peas', 'trip: bus', `big: ${'x'.repeat(33_000)}`)
  return s
}

test('rewrite_touched_topics marks exactly the topics citing a note since the last review stale, and the rewrite runs take them', async () => {
  const s = await reviewedThenNoted()
  try {
    s.d.hold('rewrite')
    const { result } = await s.rpc('tools/call', { name: 'rewrite_touched_topics', arguments: {} })
    expect(text(result)).toEqual({ queued: ['garden', 'trip'], overCap: ['big'] })
    const stale = () => Object.fromEntries(s.z.listViews().filter((v) => v.kind === 'organizer').map((v) => [v.slug, v.bodyStale ?? false]))
    expect(stale()).toEqual({ garden: true, compost: false, trip: true, big: false })

    s.d.release()
    await s.z.idle()
    expect(s.d.calls.filter((c) => c.startsWith('rewrite'))).toEqual(['rewrite garden', 'rewrite trip'])
    expect(stale()).toEqual({ garden: false, compost: false, trip: false, big: false })
    expect(s.view('organizer/garden')!.body).toBe('- garden: beans\n- garden: peas')
    expect(text(await s.call('get_review')).rewrites.map((r: any) => [r.slug, r.yours])).toEqual([
      ['garden', true],
      ['trip', true],
    ])
  } finally {
    s.close()
  }
})
