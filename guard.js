/**
 * Pure Perplexity request and provider repairs.
 *
 * The Host plugin applies these on the live call and, when asked, to the
 * llm-pi-ai provider profile. No Cordis, no I/O.
 */

/** Built-in Agent API names that 400 when used as a custom function. */
export const RESERVED_TOOLS = Object.freeze([
  'web_search',
  'search_files',
  'fetch_url',
  'people_search',
  'finance_search',
  'image_search',
  'sandbox',
])

/** Models this profile actually runs, and the settings those calls require. */
export const FOCUS_MODELS = Object.freeze([
  {
    id: 'openai/gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    maxTokens: 32768,
    contextWindow: 200000,
    reasoning: true,
  },
  {
    id: 'anthropic/claude-opus-5-5',
    name: 'Claude Opus 5.5',
    maxTokens: 32768,
    contextWindow: 200000,
    reasoning: true,
  },
  {
    id: 'anthropic/claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    maxTokens: 32768,
    contextWindow: 200000,
    reasoning: true,
  },
])

/** Efforts already proven on this desktop route. `off` is not a Perplexity wire value. */
export const REASONING_EFFORTS = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
})

export const OFFICIAL_BASE_URL = 'https://api.perplexity.ai/v1'
export const LONG_IDLE_MS = 900000
export const IDLE_FLOOR_MS = 600000

const PREFIX = 'dsh_'
const NAME_KEYS = new Set(['name', 'toolName', 'tool'])
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'])

/**
 * @param {readonly { name?: string }[]} tools
 * @returns {Map<string, string>} alias -> original
 */
export function aliasMapFor(tools) {
  const reserved = new Set(RESERVED_TOOLS)
  const taken = new Set()
  for (const tool of tools) {
    if (tool && typeof tool.name === 'string') taken.add(tool.name)
  }
  /** @type {Map<string, string>} */
  const toOriginal = new Map()
  for (const name of reserved) {
    if (!taken.has(name)) continue
    let alias = `${PREFIX}${name}`
    let suffix = 2
    while (taken.has(alias) || toOriginal.has(alias)) {
      alias = `${PREFIX}${name}_${suffix}`
      suffix += 1
    }
    taken.add(alias)
    toOriginal.set(alias, name)
  }
  return toOriginal
}

/**
 * @param {Map<string, string>} toOriginal
 * @returns {Map<string, string>}
 */
function invert(toOriginal) {
  /** @type {Map<string, string>} */
  const toAlias = new Map()
  for (const [alias, name] of toOriginal) toAlias.set(name, alias)
  return toAlias
}

/**
 * @param {string} text
 * @param {Map<string, string>} toAlias
 * @returns {string}
 */
function rewriteSystemText(text, toAlias) {
  let out = text
  for (const [name, alias] of toAlias) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), alias)
  }
  return out
}

/**
 * @param {unknown} value
 * @param {Map<string, string>} rename
 * @returns {unknown}
 */
function renameTool(value, rename) {
  if (!value || typeof value !== 'object') return value
  return rename.has(value.name) ? { ...value, name: rename.get(value.name) } : value
}

// Only traverse DSH-owned envelopes. Arguments, schemas, replay signatures,
// tool results and provider metadata are opaque application data.
function rewriteMessage(message, rename) {
  if (!message || typeof message !== 'object') return message
  const privileged = message.role === 'system' || message.role === 'developer'
  if (!Array.isArray(message.content)) {
    return privileged && typeof message.content === 'string'
      ? { ...message, content: rewriteSystemText(message.content, rename) }
      : message
  }
  return { ...message, content: message.content.map(block => {
    if (!block || typeof block !== 'object') return block
    if (message.role === 'assistant' && block.type === 'tool-call') return renameTool(block, rename)
    if (message.role === 'developer' && (block.type === 'tool-addition' || block.type === 'tool-removal') && rename.has(block.toolName)) {
      return { ...block, toolName: rename.get(block.toolName) }
    }
    if (privileged && block.type === 'text' && typeof block.text === 'string') {
      return { ...block, text: rewriteSystemText(block.text, rename) }
    }
    return block
  }) }
}

/**
 * Fill the schema holes Perplexity rejects, without touching call arguments.
 * @param {Record<string, unknown>} tool
 * @returns {{ tool: Record<string, unknown>, notes: string[] }}
 */
function normalizeTool(tool) {
  /** @type {string[]} */
  const notes = []
  const next = { ...tool }
  if (typeof next.description !== 'string' || next.description.trim() === '') {
    const name = typeof next.name === 'string' && next.name !== '' ? next.name : 'tool'
    next.description = `Runs the ${name} tool.`
    notes.push('tool-description')
  }
  if (!next.parameters || typeof next.parameters !== 'object') return { tool: next, notes }
  let changed = false
  function walk(value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(walk)
    const copy = { ...value }
    // Recurse through JSON Schema applicators only, never annotations/literals.
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
        copy[key] = Object.fromEntries(Object.entries(value[key]).map(([name, schema]) => [name, walk(schema)]))
      }
    }
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (value[key] !== undefined) copy[key] = walk(value[key])
    }
    if (copy.type === 'object' && copy.properties === undefined) {
      copy.properties = {}
      changed = true
    }
    return copy
  }
  const parameters = walk(next.parameters)
  const input = parameters.properties?.input
  if (next.name === 'cordis_inspect_query' && input && typeof input === 'object' &&
      !['type', '$ref', 'anyOf', 'oneOf', 'allOf', 'enum', 'const'].some(key => key in input)) {
    const ref = '#/$defs/dshCompatJsonValue'
    parameters.properties = {
      ...parameters.properties,
      input: { ...input, $ref: ref },
    }
    parameters.$defs = {
      ...(parameters.$defs ?? {}),
      dshCompatJsonValue: {
        anyOf: [
          { type: 'object', properties: {}, additionalProperties: { $ref: ref } },
          { type: 'array', items: { $ref: ref } },
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
        ],
      },
    }
    changed = true
    notes.push('inspect-input')
  }
  if (changed) {
    next.parameters = parameters
    notes.push('schema-properties')
  }
  return { tool: next, notes }
}

/**
 * Copy a Perplexity request so reserved names, missing descriptions, and
 * empty object schemas do not 400 the call. The original object is not mutated.
 * @param {Record<string, unknown>} options
 * @returns {{ changed: boolean, options: Record<string, unknown>, toOriginal: Map<string, string>, notes: string[] }}
 */
export function aliasRequest(options) {
  const tools = Array.isArray(options.tools) ? options.tools : []
  const toOriginal = aliasMapFor(tools)
  /** @type {string[]} */
  const notes = []
  let normalized = false
  const normalizedTools = tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool
    const result = normalizeTool(tool)
    if (result.notes.length > 0) normalized = true
    for (const note of result.notes) {
      if (!notes.includes(note)) notes.push(note)
    }
    return result.tool
  })
  if (toOriginal.size > 0) notes.unshift('reserved-tool')
  if (toOriginal.size === 0 && !normalized) {
    return { changed: false, options, toOriginal, notes }
  }
  const toAlias = invert(toOriginal)
  const rewritten = { ...options }
  if (Array.isArray(options.tools)) rewritten.tools = normalizedTools.map(tool => renameTool(tool, toAlias))
  if (Array.isArray(options.messages)) rewritten.messages = options.messages.map(message => rewriteMessage(message, toAlias))
  if (typeof options.system === 'string') rewritten.system = rewriteSystemText(options.system, toAlias)
  if (typeof options.instructions === 'string') rewritten.instructions = rewriteSystemText(options.instructions, toAlias)
  return { changed: true, options: rewritten, toOriginal, notes }
}

/**
 * @param {unknown} chunk
 * @param {Map<string, string>} toOriginal
 * @returns {unknown}
 */
export function restoreChunk(chunk, toOriginal) {
  if (toOriginal.size === 0 || chunk === null || typeof chunk !== 'object') return chunk
  if (chunk.type === 'tool-call' || chunk.type === 'tool-call-delta') return renameTool(chunk, toOriginal)
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
    return { ...chunk, block: renameTool(chunk.block, toOriginal) }
  }
  return chunk
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** No legal adapter output budget fits the estimated remaining context. */
export class ContextWindowExceededError extends Error {
  constructor(room) {
    super(`Estimated remaining context (${room} tokens) is below the adapter minimum of 16`)
    this.name = 'ContextWindowExceededError'
    this.code = 'CONTEXT_WINDOW_EXCEEDED'
    this.room = room
  }
}

/**
 * Bound output using the supplied input estimate, not a tokenizer guarantee.
 * @throws {ContextWindowExceededError} When fewer than 16 tokens remain.
 * @param {{ maxTokens: number, inputTokens?: number, contextWindow?: number, headroom?: number, floor?: number }} input
 * @returns {{ maxTokens: number, capped: boolean }}
 */
export function capMaxTokens(input) {
  const floor = input.floor ?? 256
  const context = input.contextWindow
  let maxTokens = input.maxTokens
  if (!Number.isFinite(context) || context <= 0) return { maxTokens, capped: false }
  const inputTokens = Number.isFinite(input.inputTokens) ? Math.max(0, input.inputTokens) : 0
  const headroom = Number.isFinite(input.headroom) ? Math.max(0, input.headroom) : 0
  const room = Math.floor(context - inputTokens - headroom)
  if (room < 16) throw new ContextWindowExceededError(room)
  if (room >= maxTokens) return { maxTokens, capped: false }
  const capped = Math.max(1, room)
  return { maxTokens: Math.min(maxTokens, Math.max(floor, capped) > room ? capped : Math.max(floor, capped)), capped: true }
}

/**
 * Fix call controls the adapter or Perplexity will reject.
 * Does not mutate `config`.
 * @param {Record<string, unknown>} config
 * @param {{
 *   defaultMaxTokens?: number,
 *   allowedEfforts?: readonly string[] | null,
 *   inputTokens?: number,
 *   contextWindow?: number,
 *   headroom?: number,
 * }} [limits]
 * @returns {{ config: Record<string, unknown>, notes: string[] }}
 */
export function adjustControls(config, limits = {}) {
  /** @type {string[]} */
  const notes = []
  const next = { ...config }
  const model = typeof next.model === 'string' ? next.model : ''
  const anthropic = model.startsWith('anthropic/')
  const fallback = limits.defaultMaxTokens ?? 32768
  const missingMax = typeof next.maxTokens !== 'number' || !Number.isFinite(next.maxTokens) || next.maxTokens < 1
  if (missingMax) {
    next.maxTokens = fallback
    notes.push(anthropic ? 'max-output-tokens' : 'max-tokens')
  }
  const capped = capMaxTokens({
    maxTokens: next.maxTokens,
    inputTokens: limits.inputTokens,
    contextWindow: limits.contextWindow,
    headroom: limits.headroom,
  })
  if (capped.capped && capped.maxTokens !== next.maxTokens) {
    next.maxTokens = capped.maxTokens
    notes.push('context-cap')
  }
  if (typeof next.temperature === 'number' && Number.isFinite(next.temperature)) {
    const clamped = clamp(next.temperature, 0, 2)
    if (clamped !== next.temperature) {
      next.temperature = clamped
      notes.push('temperature')
    }
  } else if (next.temperature !== undefined && next.temperature !== null) {
    delete next.temperature
    notes.push('temperature')
  }
  if (next.stop !== undefined) {
    delete next.stop
    notes.push('stop')
  }
  if (next.reasoningEffort !== undefined) {
    const effort = String(next.reasoningEffort)
    const allowed = limits.allowedEfforts
    const known = EFFORTS.has(effort)
    const listed = allowed == null ? known && effort !== 'off' : allowed.includes(effort)
    if (!listed) {
      delete next.reasoningEffort
      notes.push('reasoning-effort')
    }
  }
  return { config: next, notes }
}

/**
 * @param {unknown} provider
 * @returns {Record<string, unknown> | null}
 */
function validReasoning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.some(([id]) => id !== 'off') && entries.every(([id, wire]) =>
    id !== 'none' && EFFORTS.has(id) && (id === 'off' && wire === null ||
      typeof wire === 'string' && wire !== 'off' && EFFORTS.has(wire)))
}

function asProvider(provider) {
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) return null
  return /** @type {Record<string, unknown>} */ (provider)
}

/**
 * @param {unknown} provider
 * @returns {{ level: 'error' | 'warn', code: string, detail: string }[]}
 */
export function diagnoseProvider(provider) {
  const route = asProvider(provider)
  /** @type {{ level: 'error' | 'warn', code: string, detail: string }[]} */
  const findings = []
  if (!route) {
    findings.push({ level: 'error', code: 'missing-provider', detail: 'perplexity provider is not configured' })
    return findings
  }
  if (route.api !== 'openai-responses') {
    findings.push({
      level: 'error',
      code: 'api',
      detail: route.api ? `api is ${String(route.api)}, expected openai-responses` : 'api is missing',
    })
  }
  if (typeof route.baseURL !== 'string' || route.baseURL.trim() === '') {
    findings.push({ level: 'error', code: 'base-url', detail: 'baseURL is missing' })
  }
  if (typeof route.streamIdleTimeoutMs !== 'number' || route.streamIdleTimeoutMs < IDLE_FLOOR_MS) {
    findings.push({ level: 'warn', code: 'idle-timeout', detail: 'stream idle timeout is below 10 minutes' })
  }
  const models = Array.isArray(route.models) ? route.models : []
  const byId = new Map(models.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]))
  for (const spec of FOCUS_MODELS) {
    const model = byId.get(spec.id)
    if (!model) {
      findings.push({ level: 'error', code: 'missing-model', detail: spec.id })
      continue
    }
    if (typeof model.maxTokens !== 'number' || model.maxTokens < 1) {
      findings.push({ level: 'error', code: 'max-tokens', detail: spec.id })
    }
    if (typeof model.contextWindow !== 'number' || model.contextWindow < 1) {
      findings.push({ level: 'warn', code: 'context-window', detail: spec.id })
    }
    if (spec.reasoning && !validReasoning(model.reasoningEfforts)) {
      findings.push({ level: 'error', code: 'reasoning', detail: spec.id })
    }
    if (model.compat && Object.hasOwn(model.compat, 'requiresToolResultName')) {
      findings.push({ level: 'error', code: 'unsupported-compat', detail: spec.id })
    }
    if (model.compat?.supportsMaxOutputTokens !== true) {
      findings.push({ level: 'error', code: 'max-output-tokens', detail: spec.id })
    }
  }
  const reported = new Set(findings.map(item => `${item.code}:${item.detail}`))
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !model.id.startsWith('anthropic/')) continue
    if (typeof model.maxTokens === 'number' && model.maxTokens >= 1) continue
    const key = `max-tokens:${model.id}`
    if (reported.has(key)) continue
    findings.push({ level: 'error', code: 'max-tokens', detail: model.id })
  }
  return findings
}

/**
 * Return a repaired provider. Does not mutate the input.
 * A custom baseURL is kept. Other models are kept.
 * @param {unknown} provider
 * @returns {{ provider: Record<string, unknown> | null, changes: { code: string, detail: string }[] }}
 */
export function repairProvider(provider) {
  const route = asProvider(provider)
  /** @type {{ code: string, detail: string }[]} */
  const changes = []
  if (!route) return { provider: null, changes }
  const next = { ...route }
  if (next.api !== 'openai-responses') {
    next.api = 'openai-responses'
    changes.push({ code: 'api', detail: 'openai-responses' })
  }
  if (typeof next.baseURL !== 'string' || next.baseURL.trim() === '') {
    next.baseURL = OFFICIAL_BASE_URL
    changes.push({ code: 'base-url', detail: OFFICIAL_BASE_URL })
  }
  if (typeof next.defaultContextWindow !== 'number' || next.defaultContextWindow < 1) {
    next.defaultContextWindow = 200000
    changes.push({ code: 'default-context', detail: '200000' })
  }
  if (typeof next.defaultMaxTokens !== 'number' || next.defaultMaxTokens < 1) {
    next.defaultMaxTokens = 32768
    changes.push({ code: 'default-max-tokens', detail: '32768' })
  }
  if (typeof next.streamIdleTimeoutMs !== 'number' || next.streamIdleTimeoutMs < IDLE_FLOOR_MS) {
    next.streamIdleTimeoutMs = LONG_IDLE_MS
    changes.push({ code: 'idle-timeout', detail: String(LONG_IDLE_MS) })
  }
  const models = Array.isArray(next.models) ? next.models.map(item => ({ ...item })) : []
  const index = new Map()
  models.forEach((item, i) => {
    if (item && typeof item.id === 'string') index.set(item.id, i)
  })
  for (const spec of FOCUS_MODELS) {
    let model = index.has(spec.id) ? models[index.get(spec.id)] : null
    if (!model) {
      model = { id: spec.id, name: spec.name }
      index.set(spec.id, models.length)
      models.push(model)
      changes.push({ code: 'missing-model', detail: spec.id })
    }
    if (typeof model.maxTokens !== 'number' || model.maxTokens < 1) {
      model.maxTokens = spec.maxTokens
      changes.push({ code: 'max-tokens', detail: spec.id })
    }
    if (typeof model.contextWindow !== 'number' || model.contextWindow < 1) {
      model.contextWindow = spec.contextWindow
      changes.push({ code: 'context-window', detail: spec.id })
    }
    if (spec.reasoning && !validReasoning(model.reasoningEfforts)) {
      model.reasoningEfforts = { ...REASONING_EFFORTS }
      changes.push({ code: 'reasoning', detail: spec.id })
    }
    const compat = model.compat && typeof model.compat === 'object' ? { ...model.compat } : {}
    if (Object.hasOwn(compat, 'requiresToolResultName')) {
      delete compat.requiresToolResultName
      changes.push({ code: 'unsupported-compat', detail: spec.id })
    }
    if (compat.supportsMaxOutputTokens !== true) {
      compat.supportsMaxOutputTokens = true
      changes.push({ code: 'max-output-tokens', detail: spec.id })
    }
    model.compat = compat
  }
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !model.id.startsWith('anthropic/')) continue
    if (typeof model.maxTokens !== 'number' || model.maxTokens < 1) {
      model.maxTokens = 32768
      changes.push({ code: 'max-tokens', detail: model.id })
    }
  }
  next.models = models
  return { provider: next, changes }
}
