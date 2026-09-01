/**
 * command-clear — a real `/clear` for DSH.
 *
 * DSH has no `clear` command: sessions are append-only logs, and the only
 * sanctioned way to shrink what the model sees is compaction. `/compact`
 * already selects the maximal balanced older span (its manual path retains
 * nothing), but it pays for one full summarization request — which is exactly
 * the call that fails when a provider is flaky or the transcript is huge.
 *
 * `/clear` reuses that same durable machinery and skips the model entirely:
 *
 *   1. the handler marks its session as "clearing" and calls the ordinary
 *      `ctx.compaction.compactNow()` bracket, so admission, tool-pairing
 *      boundaries, surface-stability checks, the `compaction/*` event pair and
 *      the durability checkpoint all behave exactly as for `/compact`;
 *   2. this plugin's own `llm/stream` listener recognizes the compaction call
 *      for that marked session and answers it locally with a short marker
 *      summary instead of dispatching to any provider — no tokens, no latency,
 *      nothing that can 503;
 *   3. compaction commits that marker as the replacement node, so the model's
 *      view collapses to one line while the session log keeps every event.
 *
 * Automatic compaction, `/compact`, and ordinary conversation requests are
 * untouched: only a call whose `sessionId` is mid-`/clear` is answered locally.
 *
 * This is an AGENT-plane plugin: `compaction` lives in the preset's own realm,
 * so the row belongs inside the preset composition's `compaction` group.
 */

const USAGE = 'Usage: /clear (no arguments)'

export const name = 'command-clear'
export const inject = ['commands', 'compaction', 'llm']

/**
 * @param {any} ctx - preset context carrying `commands`, `compaction`, and `llm`.
 * @param {Record<string, unknown>} [config] - optional `{ note }` override for the marker text.
 */
export function apply(ctx, config = {}) {
  const note = resolveNote(config)
  /** Sessions whose compaction summarization must be answered locally. */
  const clearing = new Map()
  const active = new Set()

  ctx.on('llm/stream', (options, next) => {
    if (options?.purpose !== 'compaction') return next()
    const marker = clearing.get(String(options.sessionId))
    if (marker === undefined) return next()
    return markerStream(marker)
  })

  ctx.effect(function* () {
    yield async () => {
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      name: 'clear',
      description: 'Clear the conversation context (model-free compaction to a marker)',
      handler: (invocation) => {
        const operation = executeClear(ctx, invocation, clearing, note)
        active.add(operation)
        const retire = () => active.delete(operation)
        operation.then(retire, retire)
        return operation
      },
    })
  }, 'command-clear lifecycle')
}

/**
 * @param {Record<string, unknown>} config - plugin config.
 * @returns {string} the sentence appended to every marker summary.
 */
function resolveNote(config) {
  for (const key of Object.keys(config)) {
    if (key !== 'note') throw new Error(`command-clear: unknown config key "${key}"`)
  }
  const note = config.note
  if (note === undefined) {
    return 'Treat the conversation as starting fresh: do not assume any earlier task, file, decision, or plan — ask the user for what you need.'
  }
  if (typeof note !== 'string' || note.trim().length === 0) {
    throw new Error('command-clear: note must be a non-empty string')
  }
  return note
}

/**
 * Run one `/clear`: a manual compaction whose summary never leaves this process.
 *
 * @param {any} ctx - preset context.
 * @param {any} invocation - the command invocation (agent, rawInput, signal, commandId).
 * @param {Map<string, string>} clearing - session marker registry consulted by the stream listener.
 * @param {string} note - guidance sentence for the marker.
 * @returns {Promise<{ kind: 'success' | 'error', text: string, sourceEventSeq?: number }>} the command result.
 */
async function executeClear(ctx, invocation, clearing, note) {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  const sessionId = String(invocation.agent.session.id)
  clearing.set(sessionId, markerText(note))
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'Nothing to clear yet: no compactable history.' }
    return {
      kind: 'success',
      text:
        `Context cleared: ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) ` +
        'are no longer visible to the model. The session log still holds everything.',
      sourceEventSeq: result.summarySeq,
    }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Clear cancelled.' }
    return { kind: 'error', text: failureText(error) }
  } finally {
    clearing.delete(sessionId)
  }
}

/**
 * @param {string} note - guidance sentence.
 * @returns {string} the marker that replaces the cleared history.
 */
function markerText(note) {
  return `Context cleared by /clear at ${new Date().toISOString()}. The conversation before this point was dropped from the model's view at the user's request; the full history remains in the session log. ${note}`
}

/**
 * Render one failed clear for the human, mirroring the manual-compaction codes.
 *
 * @param {unknown} error - the thrown failure.
 * @returns {string} human-facing text.
 */
function failureText(error) {
  const code = /** @type {any} */ (error)?.name === 'ManualCompactionError' ? /** @type {any} */ (error).code : undefined
  switch (code) {
    case 'busy':
      return 'Clear is unavailable while this session has a compaction in flight or a turn still running.'
    case 'cancelled':
      return 'Clear cancelled.'
    case 'changed':
      return 'The history changed while clearing it. Nothing was removed; try again.'
    case 'summary':
      return 'There is not enough history for clearing to shrink anything yet.'
    case 'commit':
      return 'Clear did not finish cleanly; inspect the session state before retrying.'
    case 'persistence':
      return 'Context was cleared, but the session could not be saved.'
    default:
      return `Clear failed: ${String(/** @type {any} */ (error)?.message ?? error)}`
  }
}

/**
 * Answer one compaction request locally, in the adapter stream protocol.
 *
 * @param {string} text - the marker summary.
 * @returns {AsyncGenerator<any>} a single-text-block stream that finishes normally.
 */
async function* markerStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
