import type { AgentKind } from '../domain'
import { map } from './map'
import { organizer } from './organizer'
import { tasks } from './tasks'
import { visualizer } from './visualizer'

export { sanitizeSlug } from './common'

export const kinds: Record<string, AgentKind> = Object.fromEntries([organizer, tasks, visualizer, map].map((k) => [k.kind, k]))
