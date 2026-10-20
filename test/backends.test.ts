import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { backends } from '../src/backends'
import { parseConfig } from '../src/config'
import type { ChatMessage } from '../src/domain'
import { tempDir } from './helpers'

const SECRET_NOTE = 'note text that must stay out of argv'
const messages: ChatMessage[] = [
  { role: 'system', content: 'Reply with JSON only.' },
  { role: 'user', content: JSON.stringify({ newEntries: [{ text: SECRET_NOTE }] }) },
]

/**
 * A stand-in harness CLI. It records its argv, stdin, the files in its working folder and whether
 * CLAUDE_CODE_PLUGIN_DIRS reached it, then prints the output the test chose, exits with the chosen code,
 * or hangs when told to.
 */
async function fakeHarness(output: string, opts: { exit?: number; hang?: boolean } = {}) {
  const dir = await tempDir()
  const log = join(dir, 'log.json')
  const bin = join(dir, 'harness')
  await writeFile(
    bin,
    `#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
const stdin = await Bun.stdin.text()
const files = Object.fromEntries(readdirSync('.').map((f) => [f, readFileSync(f, 'utf8')]))
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin, files, pluginDirs: process.env.CLAUDE_CODE_PLUGIN_DIRS ?? null }))
${opts.hang ? 'await new Promise(() => {})' : ''}
process.stdout.write(${JSON.stringify(output)})
process.exit(${opts.exit ?? 0})
`,
  )
  await chmod(bin, 0o755)
  return { bin, seen: async () => JSON.parse(await readFile(log, 'utf8')) }
}

/** The config a harness backend gets, from an environment that has the mod directories set, as the user's shell does. */
const harnessConfig = (backend: 'claude-code' | 'opencode', bin: string, model?: string) =>
  parseConfig({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_CODE_PLUGIN_DIRS: '/somewhere/mods',
    ZEPHYR_BACKEND: backend,
    ZEPHYR_RELEVANCE: 'tfidf',
    ZEPHYR_HARNESS_BIN: bin,
    ...(model && { ZEPHYR_HARNESS_MODEL: model }),
  })

/** A harness backend with a short timeout; the registry's factories take it as a second argument, for tests. */
const withTimeout = (backend: 'claude-code' | 'opencode', bin: string, timeoutMs: number) => (backends[backend] as (c: ReturnType<typeof parseConfig>, t: number) => ReturnType<(typeof backends)[typeof backend]>)(harnessConfig(backend, bin), timeoutMs)

const claudeResult = (result: string, extra: object = {}) =>
  JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', is_error: false, result, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 12 }, ...extra }])

test('claude-code runs claude -p without tools, MCP, settings or a saved session, with the input on stdin and the instructions in a file', async () => {
  const h = await fakeHarness(claudeResult('```json\n{"ops":[]}\n```'))
  const reply = await backends['claude-code'](harnessConfig('claude-code', h.bin, 'sonnet')).complete(messages, { json: true })
  expect(reply).toEqual({ json: { ops: [] }, usage: { promptTokens: 152, completionTokens: 12, cachedTokens: 50 } })
  const seen = await h.seen()
  expect(seen.argv).toEqual(['-p', '--output-format', 'json', '--system-prompt-file', expect.stringMatching(/system\.txt$/), '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--model', 'sonnet'])
  expect(seen.stdin).toBe(messages[1]!.content)
  expect(seen.files['system.txt']).toBe('Reply with JSON only.')
  expect(seen.pluginDirs).toBeNull()
  expect(JSON.stringify(seen.argv)).not.toContain(SECRET_NOTE)
})

test('claude-code without a harness model leaves the model to Claude Code', async () => {
  const h = await fakeHarness(claudeResult('{}'))
  await backends['claude-code'](harnessConfig('claude-code', h.bin)).complete(messages, { json: true })
  expect((await h.seen()).argv).not.toContain('--model')
})

test('claude-code fails on an error result, a non-zero exit with or without a reply, output that is not JSON, and a hang', async () => {
  const run = async (output: string, opts?: { exit?: number; hang?: boolean }, timeoutMs = 10_000) => {
    const h = await fakeHarness(output, opts)
    return withTimeout('claude-code', h.bin, timeoutMs).complete(messages, { json: true })
  }
  await expect(run(claudeResult('rate limited', { is_error: true }), { exit: 1 })).rejects.toThrow('claude failed: rate limited')
  await expect(run('', { exit: 2 })).rejects.toThrow('claude exited 2')
  await expect(run(claudeResult('{"ops":[]}'), { exit: 3 })).rejects.toThrow('claude exited 3')
  await expect(run('Not logged in')).rejects.toThrow('claude output is not JSON')
  await expect(run('', { hang: true }, 300)).rejects.toThrow('claude gave no answer in 0.3 s')
})

const ocEvents = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'

test('opencode runs a tool-free zephyr agent in a temp folder, with the input on stdin', async () => {
  const h = await fakeHarness(
    ocEvents(
      { type: 'step_start', part: { type: 'step-start' } },
      { type: 'text', part: { type: 'text', text: '{"ops":' } },
      { type: 'text', part: { type: 'text', text: '[]}' } },
      { type: 'step_finish', part: { type: 'step-finish', tokens: { input: 1914, output: 6, cache: { read: 384 } } } },
    ),
  )
  const backend = backends.opencode(harnessConfig('opencode', h.bin, 'llm-proxy/deepseek-v4-flash-fast'))
  expect(await backend.complete(messages, { json: true })).toEqual({ json: { ops: [] }, usage: { promptTokens: 2298, completionTokens: 6, cachedTokens: 384 } })
  const seen = await h.seen()
  expect(seen.argv).toEqual(['run', 'The input follows.', '--format', 'json', '--pure', '--agent', 'zephyr', '--dir', expect.any(String), '-m', 'llm-proxy/deepseek-v4-flash-fast'])
  expect(seen.stdin).toBe(messages[1]!.content)
  expect(Object.keys(seen.files).sort()).toEqual(['opencode.json'])
  expect(JSON.parse(seen.files['opencode.json'])).toEqual({ agent: { zephyr: { mode: 'primary', prompt: 'Reply with JSON only.', tools: { '*': false }, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' } } } })
  expect(seen.pluginDirs).toBeNull()
  expect(JSON.stringify(seen.argv)).not.toContain(SECRET_NOTE)
  expect(backend.keepsCopies).toContain('opencode keeps the sessions Zephyr ran')
})

test('opencode fails on an error event, keeping only its message; on a non-zero exit with or without a reply; on no reply text; and on a hang', async () => {
  const run = async (output: string, opts?: { exit?: number; hang?: boolean }, timeoutMs = 10_000) => {
    const h = await fakeHarness(output, opts)
    return withTimeout('opencode', h.bin, timeoutMs).complete(messages, { json: true })
  }
  await expect(run(ocEvents({ type: 'error', error: { name: 'APIError', data: { message: 'Not Found', responseHeaders: { 'set-cookie': 'x' } } } }), { exit: 1 })).rejects.toThrow(/^opencode failed: Not Found$/)
  await expect(run(ocEvents({ type: 'text', part: { type: 'text', text: '{"ops":[]}' } }), { exit: 1 })).rejects.toThrow('opencode exited 1')
  await expect(run('', { exit: 2 })).rejects.toThrow('opencode exited 2')
  await expect(run(ocEvents({ type: 'step_start', part: {} }))).rejects.toThrow('opencode output has no reply text')
  await expect(run('', { hang: true }, 300)).rejects.toThrow('opencode gave no answer in 0.3 s')
})

test('the temp folder with the instructions and input is gone after the call', async () => {
  const h = await fakeHarness(claudeResult('{}'))
  await backends['claude-code'](harnessConfig('claude-code', h.bin)).complete(messages, { json: true })
  const dir = (await h.seen()).argv[4].replace(/\/system\.txt$/, '')
  expect(await Bun.file(join(dir, 'system.txt')).exists()).toBe(false)
})
