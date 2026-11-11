/**
 * Cross-restart recovery test for the session gate.
 *
 * Simulates what happens when the DSH Host restarts: the plugin module is
 * loaded fresh (no in-memory state), the state directory still holds the
 * policy files, and the Host re-creates agents with source "resume".
 *
 *   node tests/recovery.mjs
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const catalog = [
  ['read', 400, 'files'],
  ['write', 500, 'files'],
  ['grep', 300, 'files'],
  ['pwsh', 1200, 'files'],
  ['web_search', 324, 'web'],
  ['web_fetch', 340, 'web'],
  ['ego_click', 900, 'ego'],
  ['ego_snapshot', 1100, 'ego'],
  ['office_read', 950, 'office'],
  ['office_edit', 1400, 'office'],
  ['sw_status', 800, 'solidworks'],
  ['task_board_list', 700, 'board'],
  ['memory_search', 500, 'memory'],
  ['gate_status', 200, 'gate'],
  ['gate_switch', 260, 'gate'],
]

function boot() {
  const defined = new Map()
  for (const [name, bytes] of catalog) {
    defined.set(name, {
      name,
      description: 'x'.repeat(Math.max(1, bytes - name.length - 60)),
      parameters: { type: 'object', properties: {} },
    })
  }
  const restrictions = []
  const tools = {
    view(agent) {
      const hidden = new Set(agent?.__hidden ?? [])
      const visible = new Map()
      for (const [name, schema] of defined) if (!hidden.has(name)) visible.set(name, schema)
      return {
        visible,
        registrations: new Map(visible),
        knownNames: new Set(defined.keys()),
        restrictableNames: new Set(defined.keys()),
      }
    },
    schemas(agent) {
      return [...tools.view(agent).visible.values()]
    },
    definitions(agent) {
      return [...tools.view(agent).visible.values()]
    },
    restrict(agent, filter) {
      restrictions.push(filter)
      agent.__hidden = [...(agent.__hidden ?? []), ...filter.deny]
      return () => {}
    },
  }
  const listeners = new Map()
  const registered = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        defined.set(definition.name, {
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        })
        return () => {}
      },
      view: (agent) => tools.view(agent),
      schemas: (agent) => tools.schemas(agent),
      definitions: (agent) => tools.definitions(agent),
      restrict: () => {
        throw new Error('global restrict must not be called')
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get() {
      return undefined
    },
    effect(action) {
      return action()
    },
  }
  const mkAgent = (sessionId) => {
    const agent = { id: sessionId, session: { id: sessionId }, __hidden: [] }
    agent.ctx = {
      tools: {
        view: (scope) => tools.view(scope),
        schemas: (scope) => tools.schemas(scope),
        definitions: (scope) => tools.definitions(scope),
        restrict: (filter) => tools.restrict(agent, filter),
      },
    }
    return agent
  }
  return { ctx, listeners, registered, tools, restrictions, mkAgent }
}

function assert(condition, label) {
  if (!condition) {
    console.error('FAIL:', label)
    process.exitCode = 1
    throw new Error(label)
  }
  console.log('ok:', label)
}

const stateDir = await mkdtemp(join(tmpdir(), 'gate-recovery-'))
await writeFile(
  join(stateDir, 'sessions.json'),
  JSON.stringify({
    sessions: {
      'session-r': { groups: { ego: false, web: false } },
      'session-clean': { groups: {} },
    },
  }),
  'utf8',
)
await writeFile(
  join(stateDir, 'locks.json'),
  JSON.stringify({ sessions: { 'session-r': { groups: { office: 'off' } } } }),
  'utf8',
)

/* ---- first boot: load the plugin, then throw the module away ---- */
{
  const first = boot()
  const { apply } = await import('../host/index.js?boot=1')
  apply(first.ctx, { stateDir })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert(first.registered.has('gate_status'), 'first boot registered gate_status')
}

/* ---- restart: fresh module instance, only the files survive ---- */
const second = boot()
const { apply } = await import('../host/index.js?boot=2')
apply(second.ctx, { stateDir })
await new Promise((resolve) => setTimeout(resolve, 50))

const created = second.listeners.get('agent/created')
assert(typeof created === 'function', 'agent/created handler installed after restart')

const resumed = second.mkAgent('session-r')
await created({ agent: resumed, source: 'resume' })

const visible = second.tools.view(resumed).visible
assert(!visible.has('ego_click'), 'stored override (ego off) reapplied after restart')
assert(!visible.has('web_search'), 'stored override (web off) reapplied after restart')
assert(!visible.has('office_read'), "the person's lock (office off) reapplied after restart")
assert(visible.has('read'), 'unrelated tools stay visible')

const deny = second.restrictions.at(-1)?.deny ?? []
assert(deny.includes('ego_click') && deny.includes('web_search'), 'deny list rebuilt from disk after restart')
assert(deny.includes('office_read'), 'lock is part of the rebuilt deny')

const clean = second.mkAgent('session-clean')
await created({ agent: clean, source: 'resume' })
const cleanVisible = second.tools.view(clean).visible
assert(cleanVisible.has('ego_click'), 'clean session unaffected by another session override')
assert(cleanVisible.has('office_read'), "a lock set in session-r does not leak into another session")

/* the on-disk policy is still readable after the "restart" */
const sessions = JSON.parse(await readFile(join(stateDir, 'sessions.json'), 'utf8'))
assert(sessions.sessions['session-r'].groups.ego === false, 'sessions.json intact after restart')

console.log('\nrecovery test passed')
