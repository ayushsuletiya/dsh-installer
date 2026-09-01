/**
 * qwen-coder — Qwen3.8 Max as the implementation engineer behind a main agent.
 *
 * Division of labour this plugin exists to enforce:
 *
 *   main agent (Opus 5 Thinking)   Qwen3.8 Max (this plugin)
 *   ────────────────────────────   ─────────────────────────────────────────
 *   reads the repo, decides the    writes the actual code / patch / review
 *   architecture, applies edits,   from a complete spec plus the file
 *   runs builds and tests, owns    contents the main agent hands it, and
 *   verification and the answer    generates images
 *
 * Why tools and not a subagent by default: a subagent on the Qwen route spends
 * one free web-quota prompt per tool round trip, and the child would re-read
 * files the parent already has. `qwen_code` is exactly one prompt per call —
 * the plugin injects the file context itself and hands back code, so the main
 * agent keeps ownership of every write and every verification step.
 * `subagent_qwen` (composed separately in the preset) stays available for the
 * cases where Qwen genuinely should drive the files itself.
 *
 * Routing: the call goes through the `llm` service, so it uses whatever the
 * `qwen` provider in settings.yaml points at (the local desktop-app bridge),
 * and falls back to `qwen-omni` (the OmniRoute relay) when the Mac app is
 * asleep or the bridge is down. Image generation has no `llm`-service shape —
 * it is an OpenAI `/v1/images/generations` call straight at the bridge.
 *
 * AGENT-plane plugin: it registers into the host `tools` and `systemPrompt`
 * registries and publishes no service, so it needs no isolate realm.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

export const name = 'qwen-coder'
export const inject = ['tools', 'llm', 'systemPrompt']

/** Config keys this plugin accepts; anything else is a composition mistake. */
const CONFIG_KEYS = new Set([
  'provider',
  'model',
  'fallbackProvider',
  'fallbackModelPrefix',
  'effort',
  'maxTokens',
  'timeoutMs',
  'maxFileBytes',
  'maxFiles',
  'imageBaseURL',
  'imageModel',
  'imageEnabled',
  'promptOrder',
])

/** Reasoning efforts the Qwen routes declare in settings.yaml. */
const EFFORTS = ['off', 'high', 'max']

/** How the requested work shapes Qwen's output contract. */
const MODES = ['implement', 'patch', 'review', 'debug', 'explain']

/**
 * @param {Record<string, unknown>} config - raw row config.
 * @returns {Record<string, any>} resolved config with defaults applied.
 */
function resolveConfig(config) {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`qwen-coder: unknown config key "${key}"`)
  }
  const cfg = {
    provider: config.provider ?? 'qwen',
    model: config.model ?? 'qwen3.8-max',
    fallbackProvider: config.fallbackProvider ?? 'qwen-omni',
    fallbackModelPrefix: config.fallbackModelPrefix ?? 'qwen/',
    effort: config.effort ?? 'high',
    maxTokens: config.maxTokens ?? 32768,
    timeoutMs: config.timeoutMs ?? 600000,
    maxFileBytes: config.maxFileBytes ?? 400000,
    maxFiles: config.maxFiles ?? 24,
    imageBaseURL: config.imageBaseURL ?? 'http://127.0.0.1:3083/v1',
    imageModel: config.imageModel ?? 'qwen3.7-plus',
    imageEnabled: config.imageEnabled ?? true,
    promptOrder: config.promptOrder ?? 117,
  }
  if (typeof cfg.provider !== 'string' || cfg.provider.length === 0) {
    throw new Error('qwen-coder: provider must be a non-empty string')
  }
  if (typeof cfg.model !== 'string' || cfg.model.length === 0) {
    throw new Error('qwen-coder: model must be a non-empty string')
  }
  if (!EFFORTS.includes(cfg.effort)) {
    throw new Error(`qwen-coder: effort must be one of ${EFFORTS.join(', ')}`)
  }
  for (const key of ['maxTokens', 'timeoutMs', 'maxFileBytes', 'maxFiles', 'promptOrder']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1) {
      throw new Error(`qwen-coder: ${key} must be a positive integer`)
    }
  }
  return cfg
}

/**
 * @param {any} ctx - preset context carrying `tools`, `llm`, and `systemPrompt`.
 * @param {Record<string, unknown>} [config] - row config.
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  registerCodeTool(ctx, cfg)
  if (cfg.imageEnabled) registerImageTool(ctx, cfg)
  ctx.systemPrompt.section({
    name: 'qwen-coder:policy',
    order: cfg.promptOrder,
    text: promptSection(cfg),
  })
}

// ── the model-facing delegation policy ──────────────────────────────────────

/**
 * @param {Record<string, any>} cfg - resolved config.
 * @returns {string} the system-prompt section describing the division of labour.
 */
function promptSection(cfg) {
  const image = cfg.imageEnabled
    ? '\n\nUse `qwen_image` when the user wants an image generated; it returns the image itself, so look at it before reporting, and pass `save_to` when the file should persist.'
    : ''
  return (
    `Qwen3.8 Max is this session's code writer, reached with \`qwen_code\`. It is a frontier ` +
    `model with a 1M-token context on a free quota, and you are its orchestrator: for any ` +
    `non-trivial implementation, refactor, algorithm, tricky bug, or large-file review, send ` +
    `the work to \`qwen_code\` instead of writing the code yourself.\n\n` +
    `Own everything around it. Locate the relevant files and pass their paths in \`files\` — ` +
    `the tool reads them itself, so never paste file bodies into \`task\`. Write a spec ` +
    `complete enough for a model that cannot see this conversation: the goal, the exact ` +
    `signatures or behaviour required, constraints, and the conventions to follow. Then ` +
    `review what comes back, apply it with your own edit/write tools (or \`write_to\` for a ` +
    `whole new file), and run the build and tests yourself. Qwen never verifies its own work.\n\n` +
    `Pick the \`mode\` that matches the job: \`implement\` for new code, \`patch\` for changes ` +
    `to existing code (it returns exact OLD/NEW blocks you can hand straight to \`edit\`), ` +
    `\`review\`, \`debug\`, or \`explain\`.\n\n` +
    `Budget: one call is one prompt against a free web quota of roughly 100 per day, so ` +
    `batch related work into one call and keep trivial one-line edits for yourself. Nothing ` +
    `here is your own capability ceiling: when a task is faster done directly, do it directly.${image}`
  )
}

// ── the Qwen call ───────────────────────────────────────────────────────────

/**
 * Stream one Qwen completion through the `llm` service, preferring the primary
 * route and falling back to the configured relay route.
 *
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} cfg - resolved config.
 * @param {{ system: string, prompt: string, model: string, effort: string, signal?: AbortSignal }} call - the request.
 * @returns {Promise<{ text: string, reasoning: string, route: string }>} the answer and the route that produced it.
 */
async function callQwen(ctx, cfg, call) {
  const routes = [{ provider: cfg.provider, model: call.model }]
  if (cfg.fallbackProvider) {
    routes.push({ provider: cfg.fallbackProvider, model: `${cfg.fallbackModelPrefix}${call.model}` })
  }
  const failures = []
  for (const route of routes) {
    try {
      const answer = await streamOnce(ctx, cfg, call, route)
      return { ...answer, route: `${route.provider}/${route.model}` }
    } catch (error) {
      if (call.signal?.aborted) throw error
      failures.push(`${route.provider}/${route.model}: ${errorText(error)}`)
    }
  }
  throw new Error(
    `Qwen is unreachable on every configured route.\n${failures.join('\n')}\n` +
      'The local route needs the Qwen desktop app running and the bridge on ' +
      `${cfg.imageBaseURL} (check: curl -s ${cfg.imageBaseURL.replace(/\/v1$/, '')}/health).`,
  )
}

/**
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} cfg - resolved config.
 * @param {{ system: string, prompt: string, effort: string, signal?: AbortSignal }} call - the request.
 * @param {{ provider: string, model: string }} route - the provider/model pair to try.
 * @returns {Promise<{ text: string, reasoning: string }>} the streamed answer.
 */
async function streamOnce(ctx, cfg, call, route) {
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: call.prompt }],
        source: { kind: 'plugin', plugin: name },
      }),
    ],
    system: call.system,
    maxTokens: cfg.maxTokens,
    ...(call.effort === 'off' ? {} : { reasoningEffort: call.effort }),
    ...(call.signal ? { signal: call.signal } : {}),
  }
  let text = ''
  let reasoning = ''
  let finish
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish !== undefined && finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
    throw new Error(`${finish.kind}: ${errorText(finish.failure)}`)
  }
  if (text.trim().length === 0) throw new Error('the route returned no text')
  if (finish?.kind === 'max-tokens') {
    text += '\n\n[qwen-coder: output stopped at the token limit — the answer above is truncated]'
  }
  return { text, reasoning }
}

/**
 * @param {unknown} error - anything thrown or an `LlmFailure`.
 * @returns {string} a short human-readable description.
 */
function errorText(error) {
  if (error === undefined || error === null) return 'unknown failure'
  if (typeof error === 'string') return error
  const message = /** @type {any} */ (error).message
  if (typeof message === 'string' && message.length > 0) return message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// ── qwen_code ───────────────────────────────────────────────────────────────

/** Output contract per mode, appended to Qwen's system prompt. */
const MODE_CONTRACT = {
  implement:
    'Return complete, runnable code — never a sketch, never "rest of the file unchanged", ' +
    'never a TODO placeholder. Put each file in its own fenced block whose first line is a ' +
    'comment holding the file path.',
  patch:
    'Return edits, not whole files, in exactly this shape and nothing else around it:\n\n' +
    '=== EDIT <path> ===\n--- OLD\n<text copied byte-exactly from the file above>\n' +
    '--- NEW\n<replacement text>\n\n' +
    'Every OLD block must be copied character-for-character from the file content you were ' +
    'given and must occur exactly once in that file: include enough surrounding lines to make ' +
    'it unique. Emit one EDIT block per change. Use a full fenced file block only when a file ' +
    'is new or is being rewritten end to end.',
  review:
    'Report findings ordered by severity. For each: the file and line, what is wrong, why it ' +
    'matters, and the concrete fix as code. Say plainly when something is fine.',
  debug:
    'State the root cause first, then the evidence in the code that proves it, then the fix as ' +
    'code. Do not list speculative causes you cannot support from the material given.',
  explain: 'Explain precisely and concretely, citing the code given. Use code only where it clarifies.',
}

/**
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} cfg - resolved config.
 */
function registerCodeTool(ctx, cfg) {
  ctx.tools.register(
    defineTool({
      name: 'qwen_code',
      description:
        'Send a coding task to Qwen3.8 Max (frontier model, 1M context, free quota) and get ' +
        'the code back. Pass the paths of the relevant files in `files` — this tool reads them ' +
        'and gives Qwen their current contents, so do not paste file bodies into `task`. Write ' +
        '`task` as a complete standalone spec: Qwen cannot see this conversation. One call is ' +
        'one quota prompt, so batch related work. You still review the result, apply it, and ' +
        'run the tests — Qwen never touches the repository or verifies anything.',
      timeoutMs: cfg.timeoutMs,
      parameters: {
        task: {
          type: 'string',
          required: true,
          description:
            'The complete, self-contained instruction: the goal, required behaviour or exact ' +
            'signatures, constraints, and conventions to follow.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Paths whose current contents Qwen needs (absolute, or relative to the session ' +
            'working directory). Read for you and inlined as context.',
        },
        context: {
          type: 'string',
          description:
            'Extra material that is not a file: API contracts, error output, schema excerpts, ' +
            'the decision already taken.',
        },
        mode: {
          type: 'string',
          enum: MODES,
          description:
            'implement (new code, default) · patch (OLD/NEW blocks for `edit`) · review · debug · explain.',
        },
        write_to: {
          type: 'string',
          description:
            'Write the single code block Qwen returns to this path instead of routing a large ' +
            'file through your own context. Only for implement mode with one file in the answer.',
        },
        effort: {
          type: 'string',
          enum: EFFORTS,
          description: 'Qwen thinking level; defaults to high. Use max for genuinely hard problems.',
        },
        model: {
          type: 'string',
          description: `Qwen model override; defaults to ${cfg.model}.`,
        },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => renderCode(value) },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `Qwen ${args.mode ?? 'implement'}: ${firstLine(args.task)}`,
        kind: 'other',
        rawInput: args.task,
        ...(args.write_to !== undefined ? { locations: [{ path: args.write_to }] } : {}),
      }),
      async execute(args, exec) {
        const mode = args.mode ?? 'implement'
        const model = args.model ?? cfg.model
        const effort = args.effort ?? cfg.effort
        const files = await readFiles(ctx, cfg, args.files ?? [], exec)
        const started = Date.now()
        const answer = await callQwen(ctx, cfg, {
          system: codeSystemPrompt(mode),
          prompt: codePrompt(args.task, args.context, files, mode),
          model,
          effort,
          signal: exec.signal,
        })
        const value = {
          mode,
          route: answer.route,
          ms: Date.now() - started,
          text: answer.text,
          files_read: files.map((file) => ({ path: file.path, ok: file.ok, bytes: file.bytes })),
        }
        if (args.write_to !== undefined) {
          value.write = await writeCodeBlock(ctx, args.write_to, answer.text, exec)
        }
        return value
      },
    }),
  )
}

/**
 * @param {string} mode - the requested output mode.
 * @returns {string} Qwen's system prompt.
 */
function codeSystemPrompt(mode) {
  return (
    'You are Qwen3.8 Max, the implementation engineer for an autonomous coding agent. The ' +
    'agent has already read the repository and decided the approach; your job is the code ' +
    'itself, at the quality level of a senior engineer who has to maintain it.\n\n' +
    'Rules: match the conventions, language version, error handling, and libraries visible in ' +
    'the files you are given — never introduce a new dependency or framework unless asked. ' +
    'Handle the real edge cases. No placeholders, no elided regions, no invented APIs: if ' +
    'something you need was not provided, say so instead of guessing at it.\n\n' +
    `${MODE_CONTRACT[mode] ?? MODE_CONTRACT.implement}\n\n` +
    'No preamble, no pleasantries, no restating the task. After the code, add at most ten ' +
    'lines of notes for assumptions you had to make, risks, or follow-up work — omit the ' +
    'notes entirely when there are none.'
  )
}

/**
 * @param {string} task - the caller's instruction.
 * @param {string | undefined} context - extra non-file material.
 * @param {Array<{ path: string, ok: boolean, text: string }>} files - resolved file context.
 * @param {string} mode - the requested output mode.
 * @returns {string} the user-turn text for Qwen.
 */
function codePrompt(task, context, files, mode) {
  const parts = []
  if (files.length > 0) {
    const blocks = files.map((file) =>
      file.ok
        ? `--- FILE: ${file.path} ---\n${file.text}`
        : `--- FILE: ${file.path} (unavailable: ${file.text}) ---`,
    )
    parts.push(`Current repository files:\n\n${blocks.join('\n\n')}`)
  }
  if (context !== undefined && context.trim().length > 0) parts.push(`Additional context:\n\n${context}`)
  parts.push(`Task (${mode}):\n\n${task}`)
  return parts.join('\n\n')
}

/**
 * @param {any} value - the canonical tool value.
 * @returns {Array<{ type: 'text', text: string }>} model-facing blocks.
 */
function renderCode(value) {
  const parts = [`Qwen ${value.mode} via ${value.route} in ${Math.round((value.ms ?? 0) / 1000)}s.`]
  const missing = (value.files_read ?? []).filter((file) => !file.ok)
  if (missing.length > 0) {
    parts.push(`Note: could not read ${missing.map((file) => file.path).join(', ')} — Qwen worked without them.`)
  }
  if (value.write !== undefined) {
    parts.push(
      value.write.ok
        ? `Wrote ${value.write.lines} lines to ${value.write.path} (${value.write.operation}). ` +
            'Read it back and verify before you build on it.\n\nHead of the written file:\n' +
            value.write.preview
        : `Nothing was written to ${value.write.path}: ${value.write.error}\nQwen's full answer follows.`,
    )
    if (value.write.ok) return [{ type: 'text', text: parts.join('\n\n') }]
  }
  parts.push(value.text)
  return [{ type: 'text', text: parts.join('\n\n') }]
}

/** @param {string} text - any string. @returns {string} its first line, bounded. */
function firstLine(text) {
  const line = String(text).split('\n', 1)[0]
  return line.length > 72 ? `${line.slice(0, 69)}...` : line
}

// ── file context and writes ─────────────────────────────────────────────────

/**
 * Read the requested files through the `fs` service so sandbox policy applies.
 *
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} cfg - resolved config.
 * @param {readonly string[]} paths - requested paths.
 * @param {any} exec - the tool execution (session cwd, cancellation).
 * @returns {Promise<Array<{ path: string, ok: boolean, text: string, bytes: number }>>} file context entries.
 */
async function readFiles(ctx, cfg, paths, exec) {
  if (paths.length > cfg.maxFiles) {
    throw new Error(`qwen_code accepts at most ${cfg.maxFiles} files in one call (got ${paths.length})`)
  }
  const fs = ctx.get('fs')
  const entries = []
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim().length === 0) continue
    try {
      if (fs === undefined) throw new Error('the filesystem service is unavailable')
      const target = await fs.resolve(path, resolveOptions(exec))
      const info = await fs.stat(target, exec.signal)
      if (info === undefined) throw new Error('no such file')
      if (info.kind !== undefined && info.kind !== 'file') throw new Error(`not a file (${info.kind})`)
      const text = await fs.readText(target, exec.signal)
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > cfg.maxFileBytes) {
        entries.push({
          path: target.displayPath ?? path,
          ok: true,
          bytes,
          text: `${text.slice(0, cfg.maxFileBytes)}\n[truncated at ${cfg.maxFileBytes} bytes of ${bytes}]`,
        })
        continue
      }
      entries.push({ path: target.displayPath ?? path, ok: true, bytes, text })
    } catch (error) {
      entries.push({ path, ok: false, bytes: 0, text: errorText(error) })
    }
  }
  return entries
}

/**
 * @param {any} exec - the tool execution.
 * @returns {{ cwd?: string, signal?: AbortSignal }} `fs.resolve` options for this call.
 */
function resolveOptions(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  return { ...(typeof cwd === 'string' ? { cwd } : {}), ...(exec.signal ? { signal: exec.signal } : {}) }
}

/**
 * Extract the code Qwen returned and write it, through the `fs` service so the
 * session's sandbox and read-before-write policy both apply.
 *
 * @param {any} ctx - plugin context.
 * @param {string} path - the requested destination.
 * @param {string} text - Qwen's full answer.
 * @param {any} exec - the tool execution.
 * @returns {Promise<Record<string, any>>} the write receipt or its failure.
 */
async function writeCodeBlock(ctx, path, text, exec) {
  const blocks = fencedBlocks(text)
  if (blocks.length === 0) {
    return { ok: false, path, error: 'the answer contained no fenced code block' }
  }
  const code = blocks[0]
  const fs = ctx.get('fs')
  if (fs === undefined) return { ok: false, path, error: 'the filesystem service is unavailable' }
  try {
    const policy = ctx.get('sandboxPolicy')
    const sandboxPolicy = policy?.resolve({ ...(exec.agent ? { session: exec.agent.session } : {}) })
    const target = await fs.resolve(path, {
      ...resolveOptions(exec),
      ...(sandboxPolicy?.workspaceRoot !== undefined ? { cwd: sandboxPolicy.workspaceRoot } : {}),
    })
    const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
    const outcome = await fs.writeText(target, code, intent, exec.signal, sandboxPolicy)
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
    const lines = code.split('\n')
    return {
      ok: true,
      path: target.displayPath ?? path,
      operation: outcome.operation,
      lines: lines.length,
      extra_blocks: blocks.length - 1,
      preview: lines.slice(0, 40).join('\n'),
    }
  } catch (error) {
    return {
      ok: false,
      path,
      error: `${errorText(error)} (read the file first, or apply the code below with your own write tool)`,
    }
  }
}

/**
 * @param {string} text - any markdown text.
 * @returns {string[]} the contents of each fenced block, outermost first.
 */
function fencedBlocks(text) {
  const blocks = []
  const pattern = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm
  let match
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1].replace(/\n$/, '')
    if (body.trim().length > 0) blocks.push(body)
  }
  return blocks
}

// ── qwen_image ──────────────────────────────────────────────────────────────

/** Media types the attachment service can accept for an inline image block. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} cfg - resolved config.
 */
function registerImageTool(ctx, cfg) {
  ctx.tools.register(
    defineTool({
      name: 'qwen_image',
      description:
        "Generate an image with Qwen's own image model through the desktop-app bridge. Returns " +
        'the image itself so you can look at it, plus its URL; pass `save_to` to keep a copy on ' +
        'disk. One call is one quota prompt.',
      timeoutMs: cfg.timeoutMs,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'What to draw. Be concrete about subject, composition, style, and text.',
        },
        size: {
          type: 'string',
          description: 'Requested size as WIDTH*HEIGHT, e.g. 1024*1024 (default) or 1664*928.',
        },
        n: { type: 'integer', description: 'How many images (1-4, default 1). Each one costs a prompt.' },
        save_to: {
          type: 'string',
          description: 'Path to save the image to (absolute, or relative to the session working directory).',
        },
        model: { type: 'string', description: `Qwen model override; defaults to ${cfg.imageModel}.` },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => renderImage(value) },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `Qwen image: ${firstLine(args.prompt)}`,
        kind: 'other',
        rawInput: args.prompt,
        ...(args.save_to !== undefined ? { locations: [{ path: args.save_to }] } : {}),
      }),
      async execute(args, exec) {
        const count = args.n ?? 1
        if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('n must be an integer from 1 to 4')
        const urls = await generateImages(cfg, args, count, exec.signal)
        const images = []
        for (const [index, url] of urls.entries()) {
          images.push(await collectImage(ctx, cfg, url, args, index, count, exec))
        }
        return { model: args.model ?? cfg.imageModel, prompt: args.prompt, images }
      },
    }),
  )
}

/**
 * @param {Record<string, any>} cfg - resolved config.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {number} count - how many images to request.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string[]>} the returned image URLs.
 */
async function generateImages(cfg, args, count, signal) {
  const endpoint = `${cfg.imageBaseURL.replace(/\/$/, '')}/images/generations`
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({
        model: args.model ?? cfg.imageModel,
        prompt: args.prompt,
        n: count,
        size: args.size ?? '1024*1024',
      }),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    throw new Error(
      `the Qwen bridge at ${endpoint} did not answer (${errorText(error)}). Image generation needs ` +
        'the local bridge and the Qwen desktop app running; the OmniRoute relay does not serve images.',
    )
  }
  const body = await response.text()
  if (!response.ok) throw new Error(`image generation failed (HTTP ${response.status}): ${body.slice(0, 400)}`)
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`the bridge returned a non-JSON image response: ${body.slice(0, 400)}`)
  }
  const urls = (parsed?.data ?? [])
    .map((entry) => entry?.url)
    .filter((url) => typeof url === 'string' && url.length > 0)
  if (urls.length === 0) throw new Error(`no image URL came back: ${body.slice(0, 400)}`)
  return urls
}

/**
 * Download one generated image, save it when asked, and attach it so the model
 * can actually see what was produced.
 *
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} cfg - resolved config.
 * @param {string} url - the generated image URL.
 * @param {Record<string, any>} args - validated tool arguments.
 * @param {number} index - zero-based image index.
 * @param {number} count - total images in this call.
 * @param {any} exec - the tool execution.
 * @returns {Promise<Record<string, any>>} one image entry for the canonical value.
 */
async function collectImage(ctx, cfg, url, args, index, count, exec) {
  const entry = { url }
  let bytes
  let mediaType
  try {
    const response = await fetch(url, { ...(exec.signal ? { signal: exec.signal } : {}) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    entry.download_error = errorText(error)
    return entry
  }
  entry.bytes = bytes.byteLength
  entry.media_type = mediaType
  if (args.save_to !== undefined) {
    try {
      const path = savePath(args.save_to, index, count, exec)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      entry.saved_to = path
    } catch (error) {
      entry.save_error = errorText(error)
    }
  }
  const attachments = ctx.get('attachments')
  if (attachments !== undefined && IMAGE_MEDIA_TYPES.has(mediaType)) {
    try {
      const ref = await attachments.saveImage({
        data: bytes,
        mediaType,
        name: `qwen-${Date.now()}-${index + 1}`,
      })
      entry.attachment = ref
    } catch (error) {
      entry.attach_error = errorText(error)
    }
  }
  return entry
}

/**
 * @param {string} requested - the caller's `save_to`.
 * @param {number} index - zero-based image index.
 * @param {number} count - total images in this call.
 * @param {any} exec - the tool execution.
 * @returns {string} the absolute path to write.
 */
function savePath(requested, index, count, exec) {
  const cwd = exec.agent?.session?.header?.cwd
  const base = isAbsolute(requested)
    ? requested
    : resolvePath(typeof cwd === 'string' ? cwd : process.cwd(), requested)
  if (count === 1) return base
  const dot = base.lastIndexOf('.')
  const slash = base.lastIndexOf('/')
  return dot > slash ? `${base.slice(0, dot)}-${index + 1}${base.slice(dot)}` : `${base}-${index + 1}`
}

/**
 * @param {any} value - the canonical tool value.
 * @returns {Array<Record<string, any>>} text plus one image block per attached image.
 */
function renderImage(value) {
  const blocks = []
  const lines = [`Qwen (${value.model}) generated ${value.images.length} image(s).`]
  for (const [index, image] of value.images.entries()) {
    const label = value.images.length === 1 ? 'Image' : `Image ${index + 1}`
    const notes = [image.url]
    if (image.saved_to !== undefined) notes.push(`saved to ${image.saved_to}`)
    if (image.save_error !== undefined) notes.push(`not saved: ${image.save_error}`)
    if (image.download_error !== undefined) notes.push(`could not be downloaded: ${image.download_error}`)
    if (image.attach_error !== undefined) notes.push(`not shown inline: ${image.attach_error}`)
    lines.push(`${label}: ${notes.join(' — ')}`)
  }
  lines.push('The image URL is a temporary Qwen link; save the file if it must persist.')
  blocks.push({ type: 'text', text: lines.join('\n') })
  for (const image of value.images) {
    if (image.attachment !== undefined) blocks.push({ type: 'image', attachment: image.attachment })
  }
  return blocks
}
