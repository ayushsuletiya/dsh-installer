/**
 * web-search-ddg — keyless WebSearchProvider for the harness web seam (`ctx.web`).
 *
 * The shipped search provider (`deepseek-official`) needs a DEEPSEEK_API_KEY
 * credential this machine does not have, so every `web_search` call failed with
 * WEB_PROVIDER_CREDENTIAL_MISSING. This plugin registers a keyless provider
 * that runs one query through four layers, cheapest first:
 *
 *   1. direct fetch of lite.duckduckgo.com   (server-rendered table HTML)
 *   2. direct fetch of html.duckduckgo.com   (classic result divs)
 *   3. direct fetch of bing.com/search       (organic `b_algo` items)
 *   4. headless Google Chrome rendering html.duckduckgo.com — browser-tier
 *      insurance for when engines start challenging plain fetches
 *
 * Verified empirically on this machine (Chrome 151, 25 Aug 2026):
 *   - DuckDuckGo serves an anomaly/challenge page to BOTH plain fetches under
 *     load and vanilla headless Chrome…
 *   - …but passes headless Chrome that hides automation tells:
 *     `--disable-blink-features=AutomationControlled` plus a normal Chrome UA
 *     (headless otherwise leaks `HeadlessChrome` in the UA string).
 *   - Brave/Startpage/Google/Mojeek hard-block headless Chrome here, and Bing
 *     sometimes serves POISONED organic lists (unrelated translation/travel/
 *     adult SERPs) to flagged sessions while keeping the page title correct.
 * Hence every layer's output passes a relevance gate before acceptance: at
 * least one result URL/title must contain one of the query's distinctive
 * tokens (>= 4 chars). A poisoned or challenge page yields zero token overlap
 * and falls through like any other failure. Set `allowOffTopic: true` in the
 * row config to disable the gate for synonym-heavy queries.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, accessSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'web-search-ddg'
export const inject = ['web']

const PROVIDER_ID = 'ddg-local'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function resolveConfig(config = {}) {
  return {
    timeoutMs: positiveInt(config.timeoutMs, 20_000),
    browserTimeoutMs: positiveInt(config.browserTimeoutMs, 45_000),
    maxResultsCap: positiveInt(config.maxResultsCap, 15),
    allowOffTopic: config.allowOffTopic === true,
    chromePath:
      typeof config.chromePath === 'string' && config.chromePath.trim() !== ''
        ? config.chromePath.trim()
        : findChrome(),
    logFile:
      typeof config.logFile === 'string' && config.logFile.trim() !== ''
        ? config.logFile.trim()
        : join(homedir(), '.dsh', 'logs', 'web-search-ddg.log'),
  }
}

function positiveInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Cheap local probe — never makes network calls. */
function findChrome() {
  return (
    CHROME_CANDIDATES.find((p) => {
      try {
        accessSync(p)
        return true
      } catch {
        return false
      }
    }) ?? null
  )
}

/* ------------------------------- HTML parsing ------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
}

function decodeEntities(s) {
  return String(s)
    .replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (m, body) => {
      const key = body.toLowerCase()
      if (ENTITIES[key] !== undefined) return ENTITIES[key]
      if (key.startsWith('#x')) {
        const cp = parseInt(key.slice(2), 16)
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
      }
      if (key.startsWith('#')) {
        const cp = parseInt(key.slice(1), 10)
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
      }
      return m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' '))
}

/** Decode DDG `/l/?uddg=` and Bing `/ck/a?…&u=a1<base64url>` wrappers. */
function resultUrlOf(href) {
  if (!href) return null
  let u
  try {
    u = new URL(href, 'https://duckduckgo.com')
  } catch {
    return null
  }
  if (u.hostname.endsWith('duckduckgo.com') && /\/l\/?$/.test(u.pathname)) {
    const target = u.searchParams.get('uddg')
    if (target && /^https?:\/\//i.test(target)) return target
    return null
  }
  if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/a')) {
    const encoded = u.searchParams.get('u')
    if (encoded?.startsWith('a1')) {
      try {
        const decoded = Buffer.from(
          encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'),
          'base64',
        ).toString('utf-8')
        if (/^https?:\/\//i.test(decoded)) return decoded
      } catch {
        /* fall through to generic handling */
      }
    }
    return null
  }
  return /^https?:\/\//i.test(u.href) ? u.href : null
}

/**
 * Parse one DDG result page (lite dialect, html dialect, or a rendered DOM of
 * either — class names survive rendering). Returns [{url,title,snippet?}].
 */
export function parseDdgHtml(html) {
  const links = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1] ?? ''
    const cls = attrs.match(/class\s*=\s*["']?([^"'>\s]+)/i)?.[1] ?? ''
    if (!/\b(result-link|result__a)\b/.test(cls)) continue
    const url = resultUrlOf(decodeEntities(attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? ''))
    const title = stripTags(m[2] ?? '')
    if (url && title) links.push({ url, title })
  }

  const snippets = []
  const snippetRe = /<(?:td|a|div)\b[^>]*class\s*=\s*["'][^"']*(?:result-snippet|result__snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|a|div)>/gi
  while ((m = snippetRe.exec(html)) !== null) {
    const text = stripTags(m[1] ?? '')
    if (text) snippets.push(text)
  }

  return links.map((l, i) =>
    snippets.length === links.length ? { ...l, snippet: snippets[i] } : l,
  )
}

/** Parse a Bing SERP (`<li class="b_algo">` items), fetched or rendered. */
export function parseBingHtml(html) {
  const out = []
  const itemRe = /<li\b[^>]*class\s*=\s*["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  let m
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1] ?? ''
    const aMatch = block.match(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/i)
    if (!aMatch) continue
    const url = resultUrlOf(decodeEntities(aMatch[1]))
    const title = stripTags(aMatch[2])
    if (!url || !title) continue
    const capMatch =
      block.match(/class\s*=\s*["'][^"']*b_caption[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = capMatch ? stripTags(capMatch[1]) : undefined
    out.push(snippet ? { url, title, snippet } : { url, title })
  }
  return out
}

/* ------------------------------- relevance gate ---------------------------- */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'versus',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'does', 'did',
  'best', 'good', 'bad', 'new', 'old', 'top', 'vs', 'of', 'in', 'on', 'to',
])

/** Distinctive tokens of a query: words >= 4 chars outside the stoplist. */
export function queryTokens(query) {
  return [
    ...new Set(
      String(query)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  ]
}

/**
 * True when at least one source's URL or title contains one distinctive query
 * token. Poisoned SERPs (Bing bot-wall variants) share zero vocabulary with
 * the query, so this rejects them cheaply without judging quality.
 */
export function looksRelevant(query, results) {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return true // nothing distinctive to demand
  return results.some((r) => {
    const hay = `${r.url} ${r.title}`.toLowerCase()
    return tokens.some((t) => hay.includes(t))
  })
}

/* --------------------------------- layers ---------------------------------- */

async function fetchText(url, settings, outerSignal) {
  const timeout = AbortSignal.timeout(settings.timeoutMs)
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
    signal,
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`http ${res.status}`)
  return res.text()
}

async function fetchDdg(kind, query, settings, outerSignal) {
  const path = kind === 'html' ? 'html/' : 'lite/'
  const html = await fetchText(
    `https://${kind}.duckduckgo.com/${path}?q=` + encodeURIComponent(query),
    settings,
    outerSignal,
  )
  const results = parseDdgHtml(html)
  if (results.length === 0) {
    const marker = /anomaly|challenge|captcha/i.test(html) ? ' (challenge page)' : ''
    throw new Error(`ddg-${kind} returned 0 results${marker}`)
  }
  return results
}

async function fetchBing(query, settings, outerSignal) {
  const html = await fetchText(
    'https://www.bing.com/search?q=' + encodeURIComponent(query),
    settings,
    outerSignal,
  )
  const results = parseBingHtml(html)
  if (results.length === 0) throw new Error('bing fetch returned 0 results')
  return results
}

/**
 * Headless Chrome rendering of the DDG html SERP with automation tells hidden
 * (plain `--headless`, never the deprecated `--headless=new`, which hangs
 * Chrome 151 forever under --dump-dom).
 *
 * Chrome dumps the whole SERP to stdout within seconds but does not always
 * exit: updater/crash-handler children intermittently keep the process alive
 * long past --dump-dom. So never block on `close` — watch stdout, and once
 * output goes quiet with a parseable SERP in hand, take the results and kill.
 */
function chromeDdgLayer(query, settings, outerSignal) {
  return new Promise((resolve, reject) => {
    if (!settings.chromePath) {
      reject(new Error('chrome fallback unavailable: no chrome binary found'))
      return
    }
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--disable-blink-features=AutomationControlled',
      `--user-agent=${UA}`,
      '--accept-lang=en-US',
      '--window-size=1440,900',
      `--user-data-dir=${join(tmpdir(), 'dsh-ddg-chrome-profile')}`,
      '--virtual-time-budget=8000',
      `--timeout=${Math.max(3000, Math.floor(settings.browserTimeoutMs * 0.7))}`,
      '--dump-dom',
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    ]
    const child = spawn(settings.chromePath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    let settled = false
    let lastLen = -1
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      clearInterval(quietTick)
      fn(arg)
    }
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(reject, new Error(`chrome dump timed out after ${settings.browserTimeoutMs}ms`))
    }, settings.browserTimeoutMs)

    const tryParse = () => {
      if (settled || out.length === 0) return null
      const results = parseDdgHtml(out)
      return results.length > 0 ? results : null
    }
    const quietTick = setInterval(() => {
      if (settled) return
      if (out.length === lastLen) {
        const results = tryParse()
        if (results) {
          child.kill('SIGKILL')
          finish(resolve, results)
        }
      } else {
        lastLen = out.length
      }
    }, 1000)

    const onAbort = () => {
      child.kill('SIGKILL')
      finish(reject, new Error('aborted'))
    }
    if (outerSignal) {
      if (outerSignal.aborted) {
        onAbort()
        return
      }
      outerSignal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (err) => {
      outerSignal?.removeEventListener('abort', onAbort)
      finish(reject, new Error(`chrome spawn failed: ${err.message}`))
    })
    child.on('close', () => {
      outerSignal?.removeEventListener('abort', onAbort)
      const results = tryParse()
      if (results) {
        finish(resolve, results)
        return
      }
      const anomaly = /anomaly|challenge|captcha/i.test(out) ? ' (challenge page)' : ''
      finish(reject, new Error(`chrome render returned 0 results${anomaly} (${out.length} bytes)`))
    })
  })
}

/* --------------------------------- plugin ---------------------------------- */

/**
 * @param {any} ctx - host context owning `ctx.web`
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config ?? {})

  const log = (line) => {
    try {
      appendFileSync(settings.logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* logging must never break search */
    }
  }

  /** Gate wrapper around a parsed result set. */
  const gate = (label, query, results) => {
    if (!settings.allowOffTopic && !looksRelevant(query, results)) {
      throw new Error(`${label}: results share no vocabulary with the query (bot-wall poison?)`)
    }
    return results
  }

  const search = async (request, signal) => {
    const started = Date.now()
    const query = String(request?.query ?? '').trim()
    const cap = Math.min(
      positiveInt(request?.maxResults, settings.maxResultsCap),
      settings.maxResultsCap,
    )
    if (!query) throw new Error('ddg-local: empty query')

    const layers = [
      ['ddg-lite', () => fetchDdg('lite', query, settings, signal)],
      ['ddg-html', () => fetchDdg('html', query, settings, signal)],
      ['bing-fetch', () => fetchBing(query, settings, signal)],
      ['ddg-chrome', () => chromeDdgLayer(query, settings, signal)],
    ]

    let results = null
    const errors = []
    for (const [label, run] of layers) {
      if (signal?.aborted) break
      if (label === 'ddg-chrome' && !settings.chromePath) continue
      try {
        results = gate(label, query, await run())
        log(`search "${query.slice(0, 80)}" -> ${label}, ${results.length} results, ${Date.now() - started}ms`)
        break
      } catch (err) {
        if (signal?.aborted) throw err
        errors.push(`${label}: ${err.message}`)
      }
    }

    if (!results) {
      const detail = errors.join('; ') || 'aborted'
      log(`search "${query.slice(0, 80)}" FAILED (${detail})`)
      throw new Error(`ddg-local: all layers failed — ${detail}`)
    }

    // Provider-level cost bound; the seam re-enforces its own maxResults anyway.
    return {
      sources: Object.freeze(results.slice(0, cap).map((r) => Object.freeze(r))),
      truncated: false,
    }
  }

  return ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available() {
      return true // fetch layers need nothing; chrome is optional insurance
    },
    search,
  })
}
