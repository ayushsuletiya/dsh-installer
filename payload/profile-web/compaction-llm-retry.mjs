/**
 * compaction-llm-retry — host-plane resilience for compaction summarization.
 *
 * `/compact` (and automatic compaction) summarizes through ONE direct
 * `ctx.llm.stream()` call with `purpose: 'compaction'`. `@deepseek-ai/dsh-llm-retry`
 * deliberately does not cover that path: it only executes policy through the
 * agent loop's `agent/request-error` waterfall, so a single provider hiccup on
 * the summarization call fails the whole attempt ("Compaction could not produce
 * a useful summary").
 *
 * This plugin wraps the `llm/stream` waterfall for compaction calls only:
 *
 *   - it buffers every chunk of an attempt and forwards nothing until that
 *     attempt terminates, so a discarded attempt can never leak partial output
 *     into the checkpoint;
 *   - a terminal `finish { kind: 'error' }` whose failure code is retryable is
 *     retried on the same route with exponential backoff and jitter;
 *   - when the retries are spent, one final attempt may run on a different
 *     `fallback` route (a big-context, reliable model) so a flaky or
 *     size-limited primary endpoint cannot permanently block compaction;
 *   - `aborted` outcomes, successes, and non-recoverable failures after the
 *     last attempt pass through unchanged.
 *
 * Ordinary conversation requests (`purpose` unset) and session-title calls are
 * never touched.
 */

import { appendFileSync } from 'node:fs'

/** Failure codes worth repeating on the same route. */
const DEFAULT_RETRYABLE_CODES = ['SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'EMPTY_RESPONSE']

export const name = 'compaction-llm-retry'
export const inject = ['llm']

/**
 * @param {any} ctx - the host context owning `ctx.llm`.
 * @param {Record<string, unknown>} [config] - plugin config; see `resolveConfig`.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config ?? {})
  /** Requests this plugin itself issued: they must reach the adapter untouched. */
  const reentrant = new WeakSet()
  const audit = auditor(ctx, settings.logFile)

  ctx.on('llm/stream', (options, next) => {
    if (options?.purpose !== 'compaction' || reentrant.has(options)) return next()
    return streamWithRecovery(ctx, options, next, settings, reentrant, audit)
  })

  const fallback = settings.fallback
  const banner =
    `mounted: up to ${settings.retries} same-route retries` +
    (fallback === undefined ? ', no fallback route' : `, then ${fallback.provider}/${fallback.model}`)
  ctx.logger.info(`compaction-llm-retry: ${banner}`)
  audit(banner)
}

/**
 * Build the audit sink. A harness deployment that discards logger output (the
 * Web server writes nothing readable to disk) would otherwise make every
 * recovery invisible, so `logFile` keeps one line per decision.
 *
 * @param {any} ctx - host context, for reporting a broken sink once.
 * @param {string | undefined} logFile - absolute path, or undefined to disable.
 * @returns {(line: string) => void} the audit writer.
 */
function auditor(ctx, logFile) {
  if (logFile === undefined) return () => {}
  let broken = false
  return (line) => {
    if (broken) return
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch (error) {
      broken = true
      ctx.logger.warn(`compaction-llm-retry: audit log ${logFile} unusable: ${String(error)}`)
    }
  }
}

/**
 * Validate and default the plugin config, failing plugin load on a bad value.
 *
 * @param {Record<string, unknown>} config - raw config from the composition row.
 * @returns {{ retries: number, initialDelayMs: number, maxDelayMs: number, retryableCodes: string[], fallback?: { provider: string, model: string } }}
 */
function resolveConfig(config) {
  const known = new Set(['retries', 'initialDelayMs', 'maxDelayMs', 'retryableCodes', 'fallback', 'logFile'])
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new Error(`compaction-llm-retry: unknown config key "${key}"`)
  }
  const retries = positiveInteger(config.retries, 3, 'retries', 0)
  const initialDelayMs = positiveInteger(config.initialDelayMs, 1500, 'initialDelayMs', 0)
  const maxDelayMs = positiveInteger(config.maxDelayMs, 20000, 'maxDelayMs', initialDelayMs)
  const codes = config.retryableCodes ?? DEFAULT_RETRYABLE_CODES
  if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string' || code.length === 0)) {
    throw new Error('compaction-llm-retry: retryableCodes must be an array of non-empty strings')
  }
  const logFile = config.logFile
  if (logFile !== undefined && (typeof logFile !== 'string' || logFile.length === 0)) {
    throw new Error('compaction-llm-retry: logFile must be a non-empty path')
  }
  const settings = { retries, initialDelayMs, maxDelayMs, retryableCodes: [...codes], logFile }
  const fallback = config.fallback
  if (fallback === undefined || fallback === null) return settings
  if (typeof fallback !== 'object') throw new Error('compaction-llm-retry: fallback must be an object')
  const { provider, model } = /** @type {Record<string, unknown>} */ (fallback)
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    throw new Error('compaction-llm-retry: fallback requires non-empty provider and model')
  }
  return { ...settings, fallback: { provider, model } }
}

/**
 * @param {unknown} value - configured value.
 * @param {number} fallback - default when omitted.
 * @param {string} field - config field name for diagnostics.
 * @param {number} min - inclusive lower bound.
 * @returns {number} the validated integer.
 */
function positiveInteger(value, fallback, field, min) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`compaction-llm-retry: ${field} must be an integer >= ${min}`)
  }
  return value
}

/**
 * Run one compaction summarization with same-route retries and one optional
 * fallback-route attempt, forwarding only the chunks of the attempt that wins.
 *
 * @param {any} ctx - host context.
 * @param {any} options - the original compaction request.
 * @param {() => AsyncIterable<any>} next - the untouched downstream attempt.
 * @param {ReturnType<typeof resolveConfig>} settings - resolved policy.
 * @param {WeakSet<object>} reentrant - marker set for this plugin's own requests.
 * @returns {AsyncGenerator<any>} the surviving attempt's chunks.
 */
async function* streamWithRecovery(ctx, options, next, settings, reentrant, audit) {
  const plan = attemptPlan(options, settings)
  const signal = options.signal
  for (let index = 0; index < plan.length; index++) {
    const attempt = plan[index]
    const stream = index === 0 ? next() : startAttempt(ctx, options, attempt.route, reentrant)
    const outcome = await collectAttempt(stream)

    if (outcome.kind === 'thrown') throw outcome.error
    if (outcome.kind !== 'error' || signal?.aborted === true) {
      if (index > 0) audit(`recovered on attempt ${index + 1} via ${attempt.route.provider}/${attempt.route.model} (${outcome.kind})`)
      yield* outcome.chunks
      return
    }

    // A code that cannot improve by repeating the same route still deserves the
    // one different-route attempt, so skip straight to it when it exists.
    let target = index + 1
    if (!settings.retryableCodes.includes(outcome.code)) {
      const fallbackIndex = plan.findIndex((entry) => entry.fallback)
      if (fallbackIndex <= index) {
        audit(`giving up: ${attempt.route.provider}/${attempt.route.model} ${outcome.code} is not recoverable here (${outcome.message})`)
        yield* outcome.chunks
        return
      }
      target = fallbackIndex
    }
    if (target >= plan.length) {
      audit(`giving up after ${plan.length} attempts: ${outcome.code} (${outcome.message})`)
      yield* outcome.chunks
      return
    }

    const delay = backoffDelay(settings, index)
    const nextRoute = plan[target].route
    const line =
      `${attempt.route.provider}/${attempt.route.model} failed (${outcome.code}: ${outcome.message}); ` +
      `retrying in ${delay}ms on ${nextRoute.provider}/${nextRoute.model} (attempt ${target + 1}/${plan.length})`
    ctx.logger.warn(`compaction-llm-retry: ${line}`)
    audit(line)
    await sleep(delay, signal)
    if (signal?.aborted === true) {
      yield* outcome.chunks
      return
    }
    index = target - 1
  }
}

/**
 * Build the ordered attempt list: the primary route once plus its retries, then
 * the optional fallback route.
 *
 * @param {any} options - the original compaction request.
 * @param {ReturnType<typeof resolveConfig>} settings - resolved policy.
 * @returns {{ route: { provider: string, model: string }, fallback: boolean }[]} the plan.
 */
function attemptPlan(options, settings) {
  const primary = { provider: options.provider, model: options.model }
  const plan = []
  for (let attempt = 0; attempt <= settings.retries; attempt++) plan.push({ route: primary, fallback: false })
  if (settings.fallback !== undefined) plan.push({ route: settings.fallback, fallback: true })
  return plan
}

/**
 * Issue one retry attempt through the full `ctx.llm.stream()` path while
 * marking the request so this plugin does not wrap its own call.
 *
 * @param {any} ctx - host context.
 * @param {any} options - the original compaction request.
 * @param {{ provider: string, model: string }} route - route for this attempt.
 * @param {WeakSet<object>} reentrant - marker set for this plugin's own requests.
 * @returns {AsyncIterable<any>} the attempt's chunk stream.
 */
function startAttempt(ctx, options, route, reentrant) {
  const request = { ...options, provider: route.provider, model: route.model }
  if (request.provider !== options.provider) delete request.reasoningEffort
  reentrant.add(request)
  return ctx.llm.stream(request)
}

/**
 * Drain one attempt into a buffer and classify how it terminated.
 *
 * @param {AsyncIterable<any>} stream - the attempt's chunks.
 * @returns {Promise<{ kind: 'ok' | 'aborted', chunks: any[] } | { kind: 'error', chunks: any[], code: string, message: string } | { kind: 'thrown', chunks: any[], error: unknown }>} the outcome.
 */
async function collectAttempt(stream) {
  const chunks = []
  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
      if (chunk?.type !== 'finish') continue
      const reason = chunk.reason
      if (reason?.kind === 'error') {
        return {
          kind: 'error',
          chunks,
          code: String(reason.failure?.code ?? 'UNKNOWN'),
          message: String(reason.failure?.message ?? 'no message'),
        }
      }
      return { kind: reason?.kind === 'aborted' ? 'aborted' : 'ok', chunks }
    }
    return { kind: 'ok', chunks }
  } catch (error) {
    return { kind: 'thrown', chunks, error }
  }
}

/**
 * @param {{ initialDelayMs: number, maxDelayMs: number }} settings - backoff bounds.
 * @param {number} attempt - zero-based index of the attempt that just failed.
 * @returns {number} the delay in milliseconds, with ±10% jitter.
 */
function backoffDelay(settings, attempt) {
  const raw = Math.min(settings.initialDelayMs * 2 ** attempt, settings.maxDelayMs)
  const jitter = raw * 0.1 * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(raw + jitter))
}

/**
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal | undefined} signal - cancellation for the wait.
 * @returns {Promise<void>} resolves after the delay or as soon as it aborts.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
