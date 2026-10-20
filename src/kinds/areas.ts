import type { Area, View } from '../domain'
import { sanitizeSlug } from './common'

// No runtime imports beyond common.ts, so the viewer can name spaces exactly as the server does.

/** The map's areas, each with its slug; a map drawn before spaces had slugs gets them from its titles. */
export function areasOf(map: View | undefined): Area[] {
  const taken = new Set<string>()
  return (map?.areas ?? []).map((a) => {
    const slug = a.slug ?? freeSlug(a.title, taken)
    taken.add(slug)
    return { ...a, slug }
  })
}

/** A slug from the title that no space in `taken` has yet. */
export function freeSlug(title: string, taken: ReadonlySet<string>): string {
  const base = sanitizeSlug(title) || 'space'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}
