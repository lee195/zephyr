import type { AgentKind } from '../domain'
import { organizer } from './organizer'

export { sanitizeSlug } from './common'

export const kinds: Record<string, AgentKind> = Object.fromEntries([organizer].map((k) => [k.kind, k]))
