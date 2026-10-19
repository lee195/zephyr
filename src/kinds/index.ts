import type { AgentKind } from '../domain'
import { organizer } from './organizer'
import { tasks } from './tasks'

export { sanitizeSlug } from './common'

export const kinds: Record<string, AgentKind> = Object.fromEntries([organizer, tasks].map((k) => [k.kind, k]))
