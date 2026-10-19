import type { TranscriptAdapter } from '../domain'
import { claudeCode } from './claude-code'
import { codex } from './codex'
import { opencode } from './opencode'

export { parseClaudeCode } from './claude-code'
export { parseCodex } from './codex'
export { parseOpencode } from './opencode'

export const adapters: Record<string, TranscriptAdapter> = {
  [claudeCode.harness]: claudeCode,
  [codex.harness]: codex,
  [opencode.harness]: opencode,
}
