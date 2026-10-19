import type { TranscriptAdapter } from '../domain'
import { claudeCode } from './claude-code'
import { opencode } from './opencode'

export { parseClaudeCode } from './claude-code'
export { parseOpencode } from './opencode'

export const adapters: Record<string, TranscriptAdapter> = {
  [claudeCode.harness]: claudeCode,
  [opencode.harness]: opencode,
}
