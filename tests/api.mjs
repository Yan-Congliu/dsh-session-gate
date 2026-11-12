/**
 * HTTP API test for the session gate — runs the real plugin against a fake
 * tools service and feeds the registered webServer handler fake requests, so it
 * can assert the panel contract without a DSH host:
 *
 *   node tests/api.mjs
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../host/index.js'

const catalog = [
  ['read', 400],
  ['write', 500],
  ['pwsh', 1200],
  ['web_search', 324],
  ['web_fetch', 340],
  ['ego_click', 900],
  ['ego_fill', 800],
  ['office_read', 950],
  ['todo_write', 350],
]

const defined = new Map()
for (const [name, bytes] of catalog) {
  defined.set(name, {
    name,
    description: 'x'.repeat(Math.max(1, bytes - name.length - 60)),
    parameters: { type: 'object', properties: {} },
  })
}

const restrictable = new Set(defined.keys())

const tools = {
  register(definition) {
    defined.set(definition.name, {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    })
    restrictable.add(definition.name)
    return () => {}
  },
  view(agent) {
    const hidden = new Set(agent === undefined ? [] : (agent.__hidden ?? []))
    const visible = new Map()
    for (const [name, schema] of defined) if (!hidden.has(name)) visible.set(name, schema)
    return { visible, registrations: new Map(visible), knownNames: new Set(defined.keys()), restrictableNames: new Set(restrictable) }
  },
  schemas(agent) {
    return [...tools.view(agent).visible.values()]
  },
  definitions(agent) {
    return [...tools.view(agent).visible.values()]
  },
  restrict(agent, filter) {
    agent.__hidden = [...(agent.__hidden ?? []), ...filter.deny]
    return () => {}
  },
}

const liveAgents = []
const registeredTools = new Map()
const listeners = new Map()
let apiHandler

const agentsService = {
  list: () => liveAgents.slice(),
  get: (id) => liveAgents.find((agent) => agent.id === id),
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    register(definition) {
      registeredTools.set(definition.name, definition)
      tools.register(definition)
      return () => registeredTools.delete(definition.name)
    },
    view: (agent) => tools.view(agent),
    schemas: (agent) => tools.schemas(agent),
    definitions: (agent) => tools.definitions(agent),
    restrict: () => {
      throw new Error('global restrict must not be called')
    },
  },
  get(name) {
    if (name === 'agents') return agentsService
    if (name === 'webServer') return { register: (entry) => ((apiHandler = entry.handler), () => {}) }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
}

function makeAgent(sessionId, title) {
  const agent = {
    id: sessionId,
    session: { id: sessionId, title },
    presetId: 'standard',
    __hidden: [],
    ctx: {
      tools: {
        view: (scope) => tools.view(scope),
        schemas: (scope) => tools.schemas(scope),
        definitions: (scope) => tools.definitions(scope),
        restrict: (filter) => tools.restrict(agent, filter),
      },
    },
  }
  liveAgents.push(agent)
  return agent
}

const stateDir = await mkdtemp(join(tmpdir(), 'gate-api-'))
apply(ctx, { stateDir })
await new Promise((resolve) => setTimeout(resolve, 80))
assert(typeof apiHandler === 'function', 'webServer handler registered')

const created = listeners.get('agent/created')
const agentA = makeAgent('session-a', '会话 A')
await created({ agent: agentA, source: 'startup' })

const request = (method, url, body, remote = '127.0.0.1') => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}
const response = () => {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name] = value
    },
    end(text) {
      res.body = text
    },
  }
  return res
}
const call = async (method, url, body, remote) => {
  const res = response()
  await apiHandler(request(method, url, body, remote), res)
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = undefined
  }
  return { status: res.statusCode, body: parsed }
}

/* 1. loopback is mandatory */
const forbidden = await call('GET', '/session-gate/api/sessions', undefined, '10.0.0.7')
assert(forbidden.status === 403, 'non-loopback request is refused (403)')

/* 2. /sessions carries the bundle version */
const sessions = await call('GET', '/session-gate/api/sessions')
const own = JSON.parse(await readFile(new URL('../host/package.json', import.meta.url), 'utf8'))
assert(sessions.status === 200 && sessions.body.ok === true, '/sessions ok')
assert(sessions.body.version === own.version, `/sessions version matches package.json (${own.version})`)
assert(Array.isArray(sessions.body.sessions) && sessions.body.sessions.length === 1, '/sessions lists the live session')
console.log('sessions:', JSON.stringify(sessions.body.sessions))

/* 3. ?session= and the ?sessionId= alias both answer */
const byName = await call('GET', '/session-gate/api/state?session=session-a')
assert(byName.body.ok === true && byName.body.sessionId === 'session-a', 'state?session= works')
assert(byName.body.version === own.version && byName.body.bundleVersion === undefined, 'state carries version')
assert(byName.body.groups.length >= 8, 'state lists groups')
const byAlias = await call('GET', '/session-gate/api/state?sessionId=session-a')
assert(byAlias.body.ok === true && byAlias.body.sessionId === 'session-a', 'state?sessionId= is accepted as an alias')
assert(byAlias.body.requestedSession === 'session-a', 'the alias is echoed as requestedSession')
console.log('state: groups', byName.body.groups.length, 'visible', byName.body.visibleBytes)

/* 4. no session + exactly one live agent → fallback, and it says so */
const fallback = await call('GET', '/session-gate/api/state')
assert(fallback.body.ok === true && fallback.body.fallback === true, 'single live session is used as a read fallback')
assert(fallback.body.sessionId === 'session-a', 'fallback names the session it used')
assert(fallback.body.requestedSession === null, 'fallback reports that no session was requested')

/* 5. no session + two live agents → offline with candidates, never a guess */
makeAgent('session-b', '会话 B')
const ambiguous = await call('GET', '/session-gate/api/state')
assert(ambiguous.body.ok === false && ambiguous.body.offline === true, 'two live sessions are not auto-picked')
assert(Array.isArray(ambiguous.body.sessions) && ambiguous.body.sessions.length === 2, 'offline answer carries the candidates')
assert(typeof ambiguous.body.hint === 'string' && ambiguous.body.hint.includes('session='), 'offline answer carries a hint')
assert(typeof ambiguous.body.error === 'string' && ambiguous.body.error.includes('挑一个'), 'offline answer explains what to do')

/* 6. an unknown session id lists what is actually running */
const unknown = await call('GET', '/session-gate/api/state?session=session-gone')
assert(unknown.body.ok === false && unknown.body.offline === true, 'unknown session is offline')
assert(unknown.body.requestedSession === 'session-gone', 'unknown session is echoed back')
assert(unknown.body.sessions.length === 2, 'unknown session still gets candidates')

/* 7. writes never fall back: a missing session is refused, with candidates */
const writeNoSession = await call('POST', '/session-gate/api/switch', { groups: { web: false } })
assert(writeNoSession.status === 409 && writeNoSession.body.offline === true, 'switch without session is refused')
assert(writeNoSession.body.sessions.length === 2, 'refused switch carries the candidates')
const writeUnknown = await call('POST', '/session-gate/api/switch', { session: 'session-gone', groups: { web: false } })
assert(writeUnknown.status === 409 && writeUnknown.body.offline === true, 'switch for an unknown session is refused')
const lockNoSession = await call('POST', '/session-gate/api/lock', { group: 'web', state: 'off' })
assert(lockNoSession.status === 400 && String(lockNoSession.body.error).includes('missing session'), 'lock without session is refused')

/* 8. a real switch works through the same handler the panel uses */
const switched = await call('POST', '/session-gate/api/switch', { session: 'session-a', groups: { web: false } })
assert(switched.status === 200 && switched.body.ok === true, 'switch applies')
assert(switched.body.savedBytes > 0, 'switch reports saved bytes')
assert(switched.body.groups.find((group) => group.id === 'web').on === false, 'web group is off')
const after = await call('GET', '/session-gate/api/state?session=session-a')
assert(after.body.savedBytes === switched.body.savedBytes, 'state reflects the switch')

/* 9. gate_status tells a reporter where the state and which version */
const status = registeredTools.get('gate_status')
const statusBody = await status.execute({}, { agent: agentA })
assert(statusBody.stateDir === stateDir, 'gate_status reports stateDir')
assert(statusBody.bundleVersion === own.version, `gate_status reports the bundle version (${own.version})`)

/* 10. unknown paths stay 404 so a typo is visible */
const missing = await call('GET', '/session-gate/api/nope')
assert(missing.status === 404, 'unknown path is 404')

function assert(condition, label) {
  if (!condition) {
    console.error('FAIL:', label)
    process.exitCode = 1
    throw new Error(label)
  }
  console.log('ok:', label)
}

console.log('\napi test passed')
