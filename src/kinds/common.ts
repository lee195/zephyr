import type { Entry, EntryId } from '../domain'

export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** The cited ids in entry order, so a view's sources read oldest first however they were collected. */
export function inEntryOrder(entries: readonly Entry[], cited: ReadonlySet<EntryId>): EntryId[] {
  return entries.filter((e) => cited.has(e.id)).map((e) => e.id)
}

/** Ids the model may cite: strings among the known ids, deduplicated. */
export function knownSources(raw: unknown[], known: ReadonlySet<EntryId>): EntryId[] {
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && known.has(s)))]
}
