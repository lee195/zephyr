import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config, Endpoint, Env } from './config'
import type { ChatMessage, Completion, ModelBackend } from './domain'

export function parseModelJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(stripped)
}

/** How long one model call may take, through the endpoint or a harness. */
export const CALL_TIMEOUT_MS = 180_000

function chatEndpoint(config: Config): Endpoint {
  if (!config.chat) throw new Error('the vllm backend needs ZEPHYR_CHAT_URL, ZEPHYR_CHAT_MODEL and ZEPHYR_CHAT_KEY_VAR')
  return config.chat
}

/** POSTs body, with the configured chat model, to the chat endpoint's completions and returns the reply as JSON. */
export async function chatCompletion(config: Config, body: object, signal?: AbortSignal): Promise<any> {
  const chat = chatEndpoint(config)
  if (!chat.apiKey) throw new Error(`${chat.keyVar} missing; for the shared endpoint, start with \`wick exec --only vllm -- bun run start\``)
  const res = await fetch(`${chat.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${chat.apiKey}` },
    body: JSON.stringify({ model: chat.model, ...body }),
    signal,
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`chat endpoint ${res.status}: ${detail}`)
  }
  return res.json()
}

/** Any OpenAI-compatible chat endpoint; named for the vLLM endpoint it was first built for. */
function vllm(config: Config): ModelBackend {
  chatEndpoint(config)
  return {
    async complete(messages: ChatMessage[]) {
      const json = await chatCompletion(config, { response_format: { type: 'json_object' }, messages }, AbortSignal.timeout(CALL_TIMEOUT_MS))
      const content = json.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('chat endpoint reply has no message content')
      const usage = typeof json.usage?.prompt_tokens === 'number'
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens ?? 0,
            cachedTokens: json.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined
      return { json: parseModelJson(content), usage }
    },
  }
}

/** The system messages, and the rest, as two texts: what a harness takes as its instructions, and as its input. */
function split(messages: ChatMessage[]): { system: string; input: string } {
  const text = (role: 'system' | 'other') => messages.filter((m) => (m.role === 'system') === (role === 'system')).map((m) => m.content).join('\n\n')
  return { system: text('system'), input: text('other') }
}

/** What a harness CLI printed and how it exited. */
export interface HarnessRun {
  stdout: string
  stderr: string
  code: number
}

/**
 * Runs a harness CLI to completion in the environment config.harness.env gives it. The note text goes in files
 * under a private temp folder, deleted afterwards, or on stdin, never in argv, which `ps` shows. A child still running
 * at the timeout is killed: opencode retries an unreachable provider forever.
 */
async function runHarness(name: string, args: (dir: string) => string[], files: Record<string, string>, bin: string, env: Env, timeoutMs: number, stdin: string): Promise<HarnessRun> {
  const dir = await mkdtemp(join(tmpdir(), 'zephyr-harness-'))
  try {
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content, { mode: 0o600 })
    const child = Bun.spawn([bin, ...args(dir)], { cwd: dir, env: { ...env }, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer))
    if (timedOut) throw new Error(`${name} gave no answer in ${timeoutMs / 1000} s`)
    return { stdout, stderr, code }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Chat through the user's Claude Code: `claude -p`, with its login and, unless ZEPHYR_HARNESS_MODEL names one, its
 * default model. Its JSON output is an array of events; the last, `type: "result"`, carries the reply text in `result`,
 * `is_error`, and `usage`. No tools, no MCP servers and no setting sources load, and no session is saved, so a call
 * leaves no transcript (checked on Claude Code 2.1, 2026-10-20). The input goes on stdin, the instructions in a file.
 */
function claudeCode(config: Config, timeoutMs = CALL_TIMEOUT_MS): ModelBackend {
  const bin = config.harness.bin ?? 'claude'
  return {
    async complete(messages) {
      const { system, input } = split(messages)
      const out = await runHarness(
        'claude',
        (dir) => [
          '-p',
          '--output-format', 'json',
          '--system-prompt-file', join(dir, 'system.txt'),
          '--tools', '',
          '--no-session-persistence',
          '--strict-mcp-config',
          '--setting-sources', '',
          ...(config.harness.model ? ['--model', config.harness.model] : []),
        ],
        { 'system.txt': system },
        bin,
        config.harness.env,
        timeoutMs,
        input,
      )
      return claudeReply(out)
    },
  }
}

/** A non-zero exit fails the call even when a reply was printed: the CLI said it did not finish. */
function exited(name: string, run: HarnessRun): Error {
  return new Error(`${name} exited ${run.code}: ${(run.stderr.trim() || run.stdout.trim()).slice(0, 300)}`)
}

/** The reply, or the error the CLI reported, or its exit, in that order: a reported error says more than an exit code. */
export function claudeReply(run: HarnessRun): Completion {
  let events: unknown
  try {
    events = JSON.parse(run.stdout)
  } catch {
    if (run.code !== 0) throw exited('claude', run)
    throw new Error(`claude output is not JSON: ${run.stdout.slice(0, 200)}`)
  }
  const result = (Array.isArray(events) ? events : [events]).findLast((e: any) => e?.type === 'result') as any
  if (result?.is_error) throw new Error(`claude failed: ${String(result.result ?? result.subtype).slice(0, 300)}`)
  if (run.code !== 0) throw exited('claude', run)
  if (!result) throw new Error('claude output has no result event')
  if (typeof result.result !== 'string') throw new Error(`claude failed: ${String(result.subtype).slice(0, 300)}`)
  const u = result.usage
  const usage = typeof u?.input_tokens === 'number'
    ? { promptTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), completionTokens: u.output_tokens ?? 0, cachedTokens: u.cache_read_input_tokens }
    : undefined
  return { json: parseModelJson(result.result), usage }
}

/**
 * Chat through the user's opencode: `opencode run --format json`, with its providers and, unless ZEPHYR_HARNESS_MODEL
 * names a `provider/model`, its default model. opencode has no flag for instructions or for running without tools, so
 * each call runs in a temp folder whose `opencode.json` defines a `zephyr` agent with the instructions as its prompt
 * and every tool off; `--pure` keeps the user's plugins out. The input goes on stdin: an attached file (`-f`) reaches
 * the model cut off after about 2,000 characters, which drops most of a filing prompt. Output is one JSON event
 * per line: `text` parts carry the reply, `step_finish` the tokens, `error` a failure (checked on opencode 1.18, 2026-10-20).
 * opencode stores every run as a session, so the notes a run was shown stay in its database.
 */
function opencode(config: Config, timeoutMs = CALL_TIMEOUT_MS): ModelBackend {
  const bin = config.harness.bin ?? 'opencode'
  return {
    keepsCopies: 'opencode keeps the sessions Zephyr ran, which hold the notes those runs were shown; delete them in opencode',
    async complete(messages) {
      const { system, input } = split(messages)
      const agent = { mode: 'primary', prompt: system, tools: { '*': false }, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' } }
      const out = await runHarness(
        'opencode',
        (dir) => ['run', 'The input follows.', '--format', 'json', '--pure', '--agent', 'zephyr', '--dir', dir, ...(config.harness.model ? ['-m', config.harness.model] : [])],
        { 'opencode.json': JSON.stringify({ agent: { zephyr: agent } }) },
        bin,
        config.harness.env,
        timeoutMs,
        input,
      )
      return opencodeReply(out)
    },
  }
}

/** As claudeReply: the reply, or the error opencode reported, or its exit. */
export function opencodeReply(run: HarnessRun): Completion {
  const events = run.stdout.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : []
    } catch {
      return []
    }
  })
  const error = events.find((e) => e?.type === 'error')
  // An API error can echo request details, so only its message is kept.
  if (error) throw new Error(`opencode failed: ${String(error.error?.data?.message ?? error.error?.name ?? 'unknown error').slice(0, 300)}`)
  if (run.code !== 0) throw exited('opencode', run)
  const text = events.filter((e) => e?.type === 'text' && typeof e.part?.text === 'string').map((e) => e.part.text).join('')
  if (!text.trim()) throw new Error('opencode output has no reply text')
  const tokens = events.findLast((e) => e?.type === 'step_finish')?.part?.tokens
  const usage = typeof tokens?.input === 'number' ? { promptTokens: tokens.input + (tokens.cache?.read ?? 0), completionTokens: tokens.output ?? 0, cachedTokens: tokens.cache?.read } : undefined
  return { json: parseModelJson(text), usage }
}

export const backends = { vllm, 'claude-code': claudeCode, opencode } satisfies Record<string, (config: Config) => ModelBackend>
export type ModelBackendName = keyof typeof backends
