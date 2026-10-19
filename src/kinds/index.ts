import type { AgentKind } from '../domain'
import { organizer } from './organizer'
import { tasks } from './tasks'
import { visualizer } from './visualizer'

export { sanitizeSlug } from './common'

export const kinds: Record<string, AgentKind> = Object.fromEntries([organizer, tasks, visualizer].map((k) => [k.kind, k]))
