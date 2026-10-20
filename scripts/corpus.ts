import { join } from 'node:path'

/** One subject of the organizer fixture corpus: a topic's slug and title, and its notes, oldest first. */
export interface Subject {
  slug: string
  title: string
  notes: string[]
}

export const CORPUS_PATH = join(import.meta.dir, 'fixtures/organizer-corpus.json')

/** The subjects of the corpus at path, the organizer fixture corpus by default. */
export async function loadCorpus(path = CORPUS_PATH): Promise<Subject[]> {
  return ((await Bun.file(path).json()) as { subjects: Subject[] }).subjects
}
