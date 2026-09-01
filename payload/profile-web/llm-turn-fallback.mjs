/**
 * llm-turn-fallback — keep a conversation turn alive when its route refuses.
 *
 * `@deepseek-ai/dsh-llm-retry` retries the SAME route (provider retryPolicy),
 * which is the right first move for a blip but useless when a specific model's
 * capacity is gone: NVIDIA's free NIM tier answers `429 RATE_LIMIT (no body)`
 * for a busy model, so five retries — even with seconds of backoff — all land on
 * the same closed door and the turn dies with "This turn failed".
 *
 * This plugin adds the missing last step: one attempt per configured FALLBACK
 * route, in order, so the turn finishes on another model instead of failing.
 *
 * Streaming is preserved, which is the whole design constraint:
 *
 *   - chunks are forwarded as they arrive, never buffered to the end;
 *   - recovery is therefore only attempted while NOTHING has been forwarded yet.
 *     A rate limit always fails before the first token, which is exactly the
 *     case worth saving; a route that dies mid-answer is passed through
 *     untouched, because half an answer cannot be un-sent and re-generated.
 *   - `aborted` outcomes and non-retryable failures pass straight through.
 *
 * Compaction is left alone — `compaction-llm-retry` owns that path and buffers
 * whole attempts, which is safe there and unsafe here.
 */

import { appendFileSync } from 'node:fs'

/** Failure codes where a different route is worth one attempt. */
const DEFAULT_RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE']

export const name = 'llm-turn-fallback'
export const inject = ['llm']

/**
 * @param {any} ctx - the host context owning `ctx.llm`.
 * @param {Record<string, unknown>} [config] - plugin config; see `resolveConfig`.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config ?? {})
  const reentrant = new WeakSet()
  const audit = auditor(ctx, settings.logFile)

  ctx.on('llm/stream', (options, next) => {
    if (options?.purpose === 'compaction' || reentrant.has(options)) return next()
    if (settings.routes.length === 0) return next()
    return streamWithFallback(ctx, options, next, settings, reentrant, audit)
  })

  const chain = settings.routes.map((r) => `${r.provider}/${r.model}`).join(' → ') || '(none)'
  const banner = `mounted: on ${settings.retryableCodes.join('/')} before first output, fall back to ${chain}`
  ctx.logger.info(`llm-turn-fallback: ${banner}`)
  audit(banner)
}

/**
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
      ctx.logger.warn(`llm-turn-fallback: audit log ${logFile} unusable: ${String(error)}`)
    }
  }
}

/**
 * @param {Record<string, unknown>} config - raw config from the composition row.
 * @returns {{ routes: {provider: string, model: string}[], retryableCodes: string[], onlyProviders: string[], logFile?: string }}
 */
function resolveConfig(config) {
  const known = new Set(['routes', 'retryableCodes', 'onlyProviders', 'logFile'])
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new Error(`llm-turn-fallback: unknown config key "${key}"`)
  }
  const rawRoutes = config.routes ?? []
  if (!Array.isArray(rawRoutes)) throw new Error('llm-turn-fallback: routes must be an array')
  const routes = rawRoutes.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`llm-turn-fallback: routes[${index}] must be an object`)
    }
    const { provider, model } = /** @type {Record<string, unknown>} */ (entry)
    if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
      throw new Error(`llm-turn-fallback: routes[${index}] requires non-empty provider and model`)
    }
    return { provider, model }
  })
  const codes = config.retryableCodes ?? DEFAULT_RETRYABLE_CODES
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string' || c.length === 0)) {
    throw new Error('llm-turn-fallback: retryableCodes must be an array of non-empty strings')
  }
  const only = config.onlyProviders ?? []
  if (!Array.isArray(only) || only.some((p) => typeof p !== 'string' || p.length === 0)) {
    throw new Error('llm-turn-fallback: onlyProviders must be an array of non-empty strings')
  }
  const logFile = config.logFile
  if (logFile !== undefined && (typeof logFile !== 'string' || logFile.length === 0)) {
    throw new Error('llm-turn-fallback: logFile must be a non-empty path')
  }
  return { routes, retryableCodes: [...codes], onlyProviders: [...only], logFile }
}

/**
 * Forward the primary attempt live; if it fails before emitting anything with a
 * recoverable code, try each fallback route in turn.
 *
 * @param {any} ctx - host context.
 * @param {any} options - the original request.
 * @param {() => AsyncIterable<any>} next - the untouched downstream attempt.
 * @param {ReturnType<typeof resolveConfig>} settings - resolved policy.
 * @param {WeakSet<object>} reentrant - marker set for this plugin's own requests.
 * @param {(line: string) => void} audit - audit sink.
 * @returns {AsyncGenerator<any>} the surviving attempt's chunks.
 */
async function* streamWithFallback(ctx, options, next, settings, reentrant, audit) {
  const primary = { provider: options.provider, model: options.model }
  if (settings.onlyProviders.length > 0 && !settings.onlyProviders.includes(primary.provider)) {
    yield* next()
    return
  }
  // Never fall back onto the route that just failed.
  const chain = settings.routes.filter(
    (route) => route.provider !== primary.provider || route.model !== primary.model,
  )
  const signal = options.signal

  for (let index = 0; index <= chain.length; index++) {
    const route = index === 0 ? primary : chain[index - 1]
    const stream = index === 0 ? next() : startAttempt(ctx, options, route, reentrant)
    let emitted = false
    /** @type {{code: string, message: string, chunk: any} | undefined} */
    let failure

    try {
      for await (const chunk of stream) {
        const reason = chunk?.type === 'finish' ? chunk.reason : undefined
        if (reason?.kind === 'error' && !emitted) {
          failure = {
            code: String(reason.failure?.code ?? 'UNKNOWN'),
            message: String(reason.failure?.message ?? reason.failure?.code ?? 'unknown failure'),
            chunk,
          }
          break
        }
        yield chunk
        emitted = true
      }
    } catch (error) {
      if (emitted) throw error
      failure = { code: 'THROWN', message: String(error), chunk: undefined }
    }

    if (failure === undefined) return
    const last = index === chain.length
    const recoverable = settings.retryableCodes.includes(failure.code)

    if (!recoverable || last || signal?.aborted === true) {
      const why = !recoverable ? 'not recoverable' : last ? 'no routes left' : 'aborted'
      audit(`giving up on ${route.provider}/${route.model}: ${failure.code} (${why})`)
      if (failure.chunk !== undefined) yield failure.chunk
      return
    }

    const target = chain[index]
    const line =
      `${route.provider}/${route.model} failed before any output (${failure.code}: ${failure.message}); ` +
      `finishing this turn on ${target.provider}/${target.model}`
    ctx.logger.warn(`llm-turn-fallback: ${line}`)
    audit(line)
  }
}

/**
 * @param {any} ctx - host context.
 * @param {any} options - the original request.
 * @param {{ provider: string, model: string }} route - route for this attempt.
 * @param {WeakSet<object>} reentrant - marker set for this plugin's own requests.
 * @returns {AsyncIterable<any>} the attempt's chunk stream.
 */
function startAttempt(ctx, options, route, reentrant) {
  const request = { ...options, provider: route.provider, model: route.model }
  // A reasoning level is provider-specific; carrying it to another vendor is a
  // hard error on some adapters, so drop it whenever the vendor changes.
  if (request.provider !== options.provider) delete request.reasoningEffort
  reentrant.add(request)
  return ctx.llm.stream(request)
}
