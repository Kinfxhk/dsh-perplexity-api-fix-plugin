/**
 * Perplexity guard.
 *
 * Agent controls are adjusted at agent/request, before preparation/logging;
 * marked agent streams retain those controls. Direct streams also use fresh
 * model metadata and an input estimate. Anthropic models get `maxTokens`
 * (this build sends `max_output_tokens`), unsupported controls are removed,
 * and wire-only tool aliases/schema repairs are restored on output.
 * A sidebar action can fill provider settings for Opus 5.5, Sonnet 5.5, and
 * GPT-6.1 Sol. Wire-copy reentry cannot retain a prepared adapter generation
 * with this host's public middleware API (see the stream hook below).
 *
 * @module @local/perplexity-guard
 */
import z from '@deepseek-ai/schemastery'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { adjustControls, aliasRequest, diagnoseProvider, repairProvider, restoreChunk } from './guard.js'

const NS = 'perplexity-guard'
const ROOT = '/perplexity-guard'
const MAX_BODY = 64_000
const LOG_LIMIT = 40

export const name = NS
export const inject = ['llm']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  providerId: z.string().default('perplexity').volatile(),
  defaultMaxTokens: z.number().min(256).max(128000).default(32768).volatile(),
  contextWindow: z.number().min(1024).max(2_000_000).default(200000).volatile(),
  headroomTokens: z.number().min(0).max(100000).default(4096).volatile(),
})

/**
 * @param {unknown} field
 * @param {unknown} fallback
 * @returns {unknown}
 */
function valueOf(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field === undefined ? fallback : field
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean}
 */
function sameOrigin(req, res) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    if (new URL(origin).host !== req.headers.host) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request denied' })
      return false
    }
  } catch {
    sendJson(res, 403, { ok: false, error: 'invalid origin' })
    return false
  }
  return true
}

/**
 * @param {{ entry?: { id?: string, name?: string, options?: { id?: string, name?: string } } }} row
 * @returns {boolean}
 */
function isLlmPiAi(row) {
  const entry = row?.entry?.options ?? row?.entry
  const id = String(entry?.id ?? '')
  const name = String(entry?.name ?? '')
  return name === '@deepseek-ai/dsh-llm-pi-ai' || id === 'llm-pi-ai' || id === 'include:llm-pi-ai' || id.endsWith('llm-pi-ai')
}

/**
 * @param {unknown} inherited
 * @param {unknown} override
 * @returns {Record<string, unknown> | null}
 */
function mergeProvider(inherited, override) {
  const base = inherited && typeof inherited === 'object' ? inherited : null
  const over = override && typeof override === 'object' ? override : null
  if (!base && !over) return null
  const merged = { ...(base ?? {}), ...(over ?? {}) }
  if (over && Array.isArray(over.models)) merged.models = over.models
  else if (base && Array.isArray(base.models)) merged.models = base.models
  return merged
}

/**
 * @param {Record<string, unknown> | null} provider
 * @returns {Record<string, unknown>}
 */
function publicProvider(provider) {
  if (!provider) return { present: false }
  const models = Array.isArray(provider.models) ? provider.models : []
  return {
    present: true,
    api: provider.api ?? null,
    baseURL: provider.baseURL ?? null,
    streamIdleTimeoutMs: provider.streamIdleTimeoutMs ?? null,
    models: models.filter(item => item && typeof item === 'object').map(item => ({
      id: item.id ?? '',
      name: item.name ?? '',
      maxTokens: item.maxTokens ?? null,
      contextWindow: item.contextWindow ?? null,
      reasoning: item.reasoningEfforts && item.reasoningEfforts !== false
        ? Object.keys(item.reasoningEfforts)
        : [],
    })),
  }
}

/**
 * @param {import('@cordisjs/core').Context} ctx
 * @param {unknown} options
 * @returns {number}
 */
function estimateInput(ctx, options) {
  const messages = []
  if (typeof options?.system === 'string' && options.system !== '') {
    messages.push({ role: 'system', content: [{ type: 'text', text: options.system }] })
  }
  if (Array.isArray(options?.messages)) messages.push(...options.messages)
  const meter = ctx.get('tokenMeter')
  if (meter) {
    try {
      return messages.reduce((sum, message) => sum + meter.estimateMessage(message), 0)
    } catch {
      // A partial message falls back to a character estimate.
    }
  }
  try {
    return Math.ceil(JSON.stringify(messages).length / 4)
  } catch {
    return 0
  }
}

/**
 * @param {AsyncIterable<unknown>} source
 * @param {Map<string, string>} toOriginal
 */
async function* restoreStream(source, toOriginal) {
  for await (const chunk of source) yield restoreChunk(chunk, toOriginal)
}

/**
 * Mount the guard.
 * @param {import('@cordisjs/core').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  /** @type {{ at: number, kind: string, detail: string }[]} */
  const activity = []
  const routed = new WeakSet()

  const enabled = () => valueOf(config.enabled, true) === true
  const providerId = () => {
    const value = String(valueOf(config.providerId, 'perplexity')).trim()
    return value === '' ? 'perplexity' : value
  }
  const limitsFor = (model, inputTokens, info) => {
    const anthropic = String(model).startsWith('anthropic/')
    return {
      defaultMaxTokens: info?.defaultMaxTokens ?? Number(valueOf(config.defaultMaxTokens, 32768)),
      headroom: Number(valueOf(config.headroomTokens, 4096)),
      contextWindow: info?.context?.contextWindow ?? Number(valueOf(config.contextWindow, 200000)),
      allowedEfforts: info ? (info.reasoning?.efforts ?? []).map(item => String(item.id)) : (anthropic ? [] : undefined),
      inputTokens,
    }
  }

  /**
   * @param {string} kind
   * @param {string} detail
   */
  const record = (kind, detail) => {
    activity.unshift({ at: Date.now(), kind, detail: String(detail).slice(0, 240) })
    if (activity.length > LOG_LIMIT) activity.length = LOG_LIMIT
  }

  const readRoute = () => {
    const editor = ctx.get('configEditor')
    if (!editor) return { error: 'config editor is not mounted' }
    const rows = editor.configuration()
    const row = rows.find(isLlmPiAi)
    if (!row) return { error: 'llm-pi-ai entry was not found' }
    const id = providerId()
    const provider = mergeProvider(row.inherited?.providers?.[id], row.override?.providers?.[id])
    return { entry: row.entry, provider, findings: diagnoseProvider(provider) }
  }

  const status = () => {
    const route = readRoute()
    return {
      ok: !route.error,
      enabled: enabled(),
      providerId: providerId(),
      ...(route.error ? { error: String(route.error) } : {}),
      findings: route.findings ?? [],
      provider: publicProvider(route.provider ?? null),
      activity,
    }
  }

  const repair = async () => {
    const editor = ctx.get('configEditor')
    if (!editor) return { ok: false, error: 'config editor is not mounted' }
    const rows = editor.configuration()
    const row = rows.find(isLlmPiAi)
    if (!row) return { ok: false, error: 'llm-pi-ai entry was not found' }
    const id = providerId()
    const existing = mergeProvider(row.inherited?.providers?.[id], row.override?.providers?.[id])
    if (!existing) return { ok: false, error: `${id} provider is not configured` }
    const repaired = repairProvider(existing)
    if (!repaired.provider) return { ok: false, error: `${id} provider could not be repaired` }
    if (repaired.changes.length === 0) {
      return { ok: true, changes: [], findings: diagnoseProvider(existing) }
    }
    await editor.edit(row.entry, (current, inherited) => {
      const providers = { ...(current?.providers ?? {}) }
      const base = mergeProvider(inherited?.providers?.[id], current?.providers?.[id]) ?? existing
      providers[id] = repairProvider(base).provider
      return { ...(current ?? {}), providers }
    })
    record('repair', repaired.changes.map(item => `${item.code}:${item.detail}`).join(', '))
    const after = readRoute()
    return { ok: true, changes: repaired.changes, findings: after.findings ?? [] }
  }

  ctx.on('agent/request', async (payload, next) => {
    const call = await next()
    if (!enabled() || call?.provider !== providerId()) return call
    const model = String(call.model ?? '')
    let info
    try {
      info = await ctx.llm.resolveModelInfo(call.provider, model, payload?.signal)
    } catch (error) {
      payload?.signal?.throwIfAborted()
      record('model-info', error instanceof Error ? error.message : 'model info unavailable')
    }
    // agent/request precedes preparation and header logging. It has no input
    // messages, so only the model window/headroom (not prompt size) is known.
    const adjusted = adjustControls(call, limitsFor(model, undefined, info))
    if (adjusted.notes.length > 0) record('request', `${model}: ${adjusted.notes.join(', ')}`)
    return adjusted.config
  })

  ctx.on('llm/stream', async function* (options, next) {
    if (!enabled() || options?.provider !== providerId() || routed.has(options)) return yield* next()
    const prepared = aliasRequest(options)
    const model = String(options.model ?? '')
    const source = prepared.changed ? prepared.options : options
    // The installed marker is an identity WeakSet, not a property or symbol.
    // Controls are already prepared/logged on agent requests; never estimate
    // the prompt or change those controls here, even if live settings changed.
    const agentRequest = isAgentLoopRequest(options)
    let info
    if (!agentRequest) {
      try {
        info = await ctx.llm.resolveModelInfo(options.provider, model, options.signal)
      } catch (error) {
        options.signal?.throwIfAborted()
        record('model-info', error instanceof Error ? error.message : 'model info unavailable')
      }
    }
    const adjusted = agentRequest ? { config: source, notes: [] }
      : adjustControls(source, limitsFor(model, estimateInput(ctx, source), info))
    const notes = [...prepared.notes, ...adjusted.notes]
    if (notes.length === 0) return yield* watch(next(), model)
    record('stream', `${model}: ${notes.join(', ')}`)
    // DSH rc.5 next() closes over the original frozen envelope. Reentry is
    // necessary for wire aliases/schema repairs, but the public middleware API
    // exposes neither the prepared dispatch nor a replacement-options next().
    // LIMITATION: reentry selects the current adapter, losing the original
    // prepareCall registration/generation binding. Do not reach into internals
    // or pretend a fresh prepareCall restores it. Unchanged calls use next().
    // Re-mark the copy for other middleware; the WeakSet prevents our reentry.
    if (agentRequest) markAgentLoopRequest(adjusted.config)
    routed.add(adjusted.config)
    return yield* watch(restoreStream(ctx.llm.stream(adjusted.config), prepared.toOriginal), model)
  })

  /**
   * @param {AsyncIterable<unknown>} source
   * @param {string} model
   */
  async function* watch(source, model) {
    for await (const chunk of source) {
      if (chunk && typeof chunk === 'object' && chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        const failure = chunk.reason.failure
        record('error', `${model}: ${failure?.code ?? ''} ${failure?.message ?? 'stream failed'}`.trim())
      }
      yield chunk
    }
  }

  ctx.inject(['webServer'], (child) => {
    const handler = async (req, res) => {
      if (!sameOrigin(req, res)) return
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const route = url.pathname.slice(ROOT.length)
      const method = req.method ?? 'GET'
      try {
        if (method === 'GET' && route === '/api/state') {
          sendJson(res, 200, status())
          return
        }
        if (method === 'POST' && route === '/api/repair') {
          await readBody(req)
          sendJson(res, 200, await repair())
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } else {
          res.end()
        }
      }
    }
    child.effect(() => child.webServer.register({ kind: 'prefix', path: ROOT, handler }), 'perplexity-guard: http')
  })

  ctx.inject(['tools'], (child) => {
    child.effect(() => child.tools.register({
      name: 'perplexity_guard',
      description: 'Read or repair Perplexity provider settings for Opus 5.5, Sonnet 5.5, and GPT-6.1 Sol. action is status or repair. status is read-only. repair writes missing maxTokens, reasoning efforts, idle timeout, and the responses API, and does not remove other models or replace a custom base URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'repair'],
            description: 'status reads the route and recent fixes. repair writes the missing provider settings.',
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        if (args?.action === 'repair') return repair()
        if (args?.action === 'status') return status()
        throw new Error('action must be status or repair')
      },
    }), 'perplexity-guard: tool')
  })
}
