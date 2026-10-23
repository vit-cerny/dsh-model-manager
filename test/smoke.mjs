// Smoke test for the Host half: runs the plugin against an in-memory context and
// exercises every HTTP endpoint and tool. No DSH process needed.
// Run: node test/smoke.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { parseJsonc, routeKey, refNameFor, normalizeOpencodeModel, protocolFor, parseEnvText } from '../lib/sources.js'
import { buildPlan, mergeRoutes, isChatModel } from '../lib/manager.js'

test('jsonc parsing tolerates comments and trailing commas', () => {
  const value = parseJsonc(`{
    // a comment
    "a": [1, 2,],
    /* block */ "b": "x//not-a-comment",
  }`)
  assert.deepEqual(value, { a: [1, 2], b: 'x//not-a-comment' })
})

test('route and reference names follow the host grammars', () => {
  assert.equal(routeKey('My Provider!'), 'my-provider')
  assert.equal(routeKey('7api'), '7api')
  assert.match(refNameFor('7api'), /^[A-Za-z_][A-Za-z0-9_]*$/)
  assert.equal(refNameFor('openai'), 'OPENAI_API_KEY')
})

test('opencode model rows prefer the wire id and carry capabilities', () => {
  const row = normalizeOpencodeModel('auto', {
    modelID: 'vendor/auto',
    name: 'Auto',
    limit: { context: 200000, output: 32000 },
    capabilities: { input: ['text', 'image'], reasoning: { supported: true, effort: ['none', 'low', 'high'] } },
  })
  assert.equal(row.id, 'vendor/auto')
  assert.equal(row.contextWindow, 200000)
  assert.deepEqual(row.input, ['text', 'image'])
  assert.deepEqual(Object.keys(row.reasoningEfforts), ['off', 'low', 'high'])
})

test('protocol mapping follows the opencode package', () => {
  assert.equal(protocolFor('@opencode/ai/providers/anthropic'), 'anthropic-messages')
  assert.equal(protocolFor('@opencode/ai/providers/openai'), 'openai-responses')
  assert.equal(protocolFor('@opencode/ai/providers/openai-compatible'), 'openai-completions')
})

test('non-chat models are filtered', () => {
  assert.equal(isChatModel('text-embedding-3', {}), false)
  assert.equal(isChatModel('whisper-1', {}), false)
  assert.equal(isChatModel('gpt-5', { name: 'GPT-5' }), true)
})

test('env parsing handles quotes and export prefixes', () => {
  assert.deepEqual(parseEnvText('export A_KEY=abc\n# c\nB_KEY="q"\n'), { A_KEY: 'abc', B_KEY: 'q' })
})

test('planning merges into an identical existing route instead of shadowing it', () => {
  const items = [{
    kind: 'provider',
    sourceId: 'demo',
    foreignId: 'gateway',
    displayName: 'Gateway',
    protocol: 'openai-completions',
    baseURL: 'https://gateway.example/v1',
    apiKey: 'secret',
    models: [{ id: 'known' }, { id: 'new' }],
  }]
  const plan = buildPlan(items, {
    existingProviders: {
      gateway: { displayName: 'Existing', api: 'openai-completions', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'KEEP_ME', models: [{ id: 'known' }] },
    },
  })
  assert.deepEqual(Object.keys(plan.routes), ['gateway'])
  assert.equal(plan.routes.gateway.apiKeyEnv, 'KEEP_ME')
  assert.deepEqual(plan.routes.gateway.models.map((model) => model.id), ['known', 'new'])
  assert.equal(JSON.stringify(plan.routes).includes('secret'), false, 'route config must not carry the key')
})

test('a conflicting route gets a distinct source-qualified key', () => {
  const plan = buildPlan([{
    kind: 'provider',
    sourceId: 'other',
    foreignId: 'gateway',
    protocol: 'openai-completions',
    baseURL: 'https://elsewhere.example/v1',
    models: [{ id: 'm' }],
  }], { existingProviders: { gateway: { baseURL: 'https://gateway.example/v1' } } })
  assert.deepEqual(Object.keys(plan.routes), ['other-gateway'])
})

test('oauth items become a grant record on a bare route', () => {
  const plan = buildPlan([{
    kind: 'oauth',
    sourceId: 'codex',
    foreignId: 'openai-codex',
    displayName: 'ChatGPT',
    grant: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
  }], {})
  assert.deepEqual(plan.routes['openai-codex'], { displayName: 'ChatGPT' })
  assert.equal(plan.records[0].key, 'llm-pi-ai/openai-codex')
})

test('mergeRoutes keeps unrelated routes', () => {
  const next = mergeRoutes({ providers: { a: { displayName: 'A' } } }, { b: { displayName: 'B' } })
  assert.deepEqual(Object.keys(next.providers).sort(), ['a', 'b'])
})

function fakeContext() {
  const providers = {}
  const refs = new Map()
  const records = new Map()
  const handlers = new Map()
  const tools = new Map()
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers } } }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect() {},
    get(service) {
      if (service === 'configEditor') {
        return {
          entries: () => [entry],
          edit: async (target, change) => {
            const next = change(structuredClone(target.options.config), {})
            for (const key of Object.keys(providers)) delete providers[key]
            Object.assign(providers, next.providers ?? {})
          },
        }
      }
      if (service === 'credentials') {
        return {
          set: async (ref, value) => { refs.set(ref, value) },
          unset: async (ref) => { refs.delete(ref) },
          listRecords: async () => [...records.keys()].map((key) => ({ key, kind: records.get(key).kind })),
          modifyRecord: async (key, mutate) => { records.set(key, await mutate(records.get(key))) },
          deleteRecord: async (key) => { records.delete(key) },
        }
      }
      return undefined
    },
    inject(names, run) {
      const services = {}
      for (const name of names) {
        if (name === 'webServer') services.webServer = { register: (route) => { handlers.set(route.path, route); return () => {} } }
        if (name === 'tools') services.tools = { register: (definition) => { tools.set(definition.name, definition); return () => {} } }
        if (name === 'systemPrompt') services.systemPrompt = { section: () => () => {} }
      }
      run({ ...ctx, ...services, effect: (fn) => fn() })
    },
  }
  apply(ctx, { enabled: true, allowWrite: true })
  return { providers, refs, records, handlers, tools }
}

async function call(handlers, path, method = 'GET', body) {
  const route = handlers.get(path)
  assert.ok(route, `route ${path} is registered`)
  const res = { status: 0, payload: undefined, writeHead(status) { this.status = status }, end(text) { this.payload = JSON.parse(text) } }
  await route.handler({
    method,
    url: path,
    headers: { origin: 'http://127.0.0.1:43120', host: '127.0.0.1:43120' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }, res)
  return { status: res.status, body: res.payload }
}

test('host routes and tools work end to end', async () => {
  const { providers, refs, records, handlers, tools } = fakeContext()

  assert.equal(tools.size, 9)

  const sources = await call(handlers, '/api/dsh-model-manager/sources')
  assert.equal(sources.status, 200)
  assert.ok(Array.isArray(sources.body.sources))
  // Hints may start with a key prefix, but a full secret must never appear.
  for (const source of sources.body.sources) {
    for (const item of source.items) {
      assert.equal(/[A-Za-z0-9_-]{30,}/.test(item.keyHint ?? ''), false, `no raw key for ${item.foreignId}`)
    }
  }

  const added = await call(handlers, '/api/dsh-model-manager/route/add', 'POST', {
    route: 'demo-gateway',
    baseURL: 'https://gateway.example/v1',
    api: 'openai-completions',
    models: ['demo-model'],
    apiKey: 'demo-secret',
  })
  assert.equal(added.status, 200)
  assert.equal(providers['demo-gateway'].displayName, 'demo-gateway')
  assert.equal(refs.get(added.body.apiKeyEnv), 'demo-secret')

  const toggled = await call(handlers, '/api/dsh-model-manager/model/toggle', 'POST', { route: 'demo-gateway', model: 'demo-model', enabled: false })
  assert.equal(toggled.status, 200)
  assert.deepEqual(providers['demo-gateway'].models, [])

  const restored = await call(handlers, '/api/dsh-model-manager/model/toggle', 'POST', { route: 'demo-gateway', model: 'demo-model', enabled: true })
  assert.equal(restored.status, 200)
  assert.deepEqual(providers['demo-gateway'].models.map((model) => model.id), ['demo-model'])

  const off = await call(handlers, '/api/dsh-model-manager/route/toggle', 'POST', { route: 'demo-gateway', enabled: false })
  assert.equal(off.status, 200)
  assert.equal(providers['demo-gateway'], undefined)

  const on = await call(handlers, '/api/dsh-model-manager/route/toggle', 'POST', { route: 'demo-gateway', enabled: true })
  assert.equal(on.status, 200)
  assert.ok(providers['demo-gateway'])

  const removed = await call(handlers, '/api/dsh-model-manager/route/remove', 'POST', { route: 'demo-gateway' })
  assert.equal(removed.status, 200)
  assert.equal(providers['demo-gateway'], undefined)
  assert.equal(records.size, 0)

  const badBody = await call(handlers, '/api/dsh-model-manager/import', 'POST', undefined)
  assert.equal(badBody.status, 400)
  assert.equal(typeof badBody.body.error, 'string')
})

test('cross-origin writes are refused', async () => {
  const { handlers } = fakeContext()
  const route = handlers.get('/api/dsh-model-manager/import')
  const res = { status: 0, payload: undefined, writeHead(status) { this.status = status }, end(text) { this.payload = JSON.parse(text) } }
  await route.handler({ method: 'POST', url: route.path, headers: { origin: 'https://evil.example' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} }, res)
  assert.equal(res.status, 403)
})

test('allowWrite false blocks writes but keeps reads', async () => {
  const providers = {}
  const handlers = new Map()
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers } } }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect() {},
    get(service) {
      if (service === 'configEditor') return { entries: () => [entry], edit: async () => {} }
      return undefined
    },
    inject(names, run) {
      const services = {}
      for (const name of names) {
        if (name === 'webServer') services.webServer = { register: (route) => { handlers.set(route.path, route); return () => {} } }
        if (name === 'tools') services.tools = { register: () => () => {} }
        if (name === 'systemPrompt') services.systemPrompt = { section: () => () => {} }
      }
      run({ ...ctx, ...services, effect: (fn) => fn() })
    },
  }
  apply(ctx, { enabled: true, allowWrite: false })
  const read = await call(handlers, '/api/dsh-model-manager/routes')
  assert.equal(read.status, 200)
  const write = await call(handlers, '/api/dsh-model-manager/route/add', 'POST', { route: 'x', baseURL: 'https://x.example/v1', models: ['m'] })
  assert.equal(write.status, 400)
  assert.match(write.body.error, /allowWrite/)
})
