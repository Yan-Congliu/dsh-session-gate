/**
 * Offline smoke test for the session gate. Runs the plugin against a fake
 * tools service, so no DSH host is needed:
 *
 *   node tests/smoke.mjs
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../host/index.js'

const catalog = [
  ['read', 400],
  ['write', 500],
  ['grep', 300],
  ['pwsh', 1200],
  ['web_search', 324],
  ['web_fetch', 340],
  ['ego_click', 900],
  ['ego_fill', 800],
  ['ego_snapshot', 1100],
  ['ego_screenshot', 700],
  ['office_read', 950],
  ['office_edit', 1400],
  ['sw_status', 800],
  ['sw_create_part', 1500],
  ['task_board_list', 700],
  ['task_board_run', 600],
  ['memory_search', 500],
  ['memory_write', 650],
  ['spawn_teammate', 600],
  ['send_message', 400],
  ['subagent', 900],
  ['session_search', 700],
  ['compress', 800],
  ['todo_write', 350],
  ['gate_status', 200],
  ['gate_switch', 260],
]

const defined = new Map()
for (const [name, bytes] of catalog) {
  const schema = {
    name,
    description: 'x'.repeat(Math.max(1, bytes - name.length - 60)),
    parameters: { type: 'object', properties: {} },
  }
  defined.set(name, schema)
}

const agents = []
const restrictions = []

function makeToolsService() {
  const service = {
    register(definition) {
      defined.set(definition.name, {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      })
      return () => {}
    },
    view(agent) {
      const hidden = new Set(agent === undefined ? [] : (agent.__hidden ?? []))
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
      const visible = service.view(agent).visible
      return [...visible.values()].map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
      }))
    },
    definitions(agent) {
      return [...service.view(agent).visible.values()]
    },
    restrict(agent, filter) {
      restrictions.push(filter)
      agent.__hidden = [...(agent.__hidden ?? []), ...filter.deny]
      let live = true
      return () => {
        if (!live) return
        live = false
        const undo = new Set(filter.deny)
        agent.__hidden = (agent.__hidden ?? []).filter((name) => !undo.has(name))
      }
    },
  }
  return service
}

const tools = makeToolsService()
const listeners = new Map()
const registeredTools = new Map()

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
    restrict: (filter) => {
      /* the real one is scoped: the caller passes its own ctx through the agent */
      throw new Error('global restrict must not be called')
    },
  },
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
}

function makeAgent(sessionId) {
  const agent = {
    id: sessionId,
    session: { id: sessionId },
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
  agents.push(agent)
  return agent
}

const stateDir = await mkdtemp(join(tmpdir(), 'gate-test-'))
apply(ctx, { stateDir })
await new Promise((resolve) => setTimeout(resolve, 50))

const created = listeners.get('agent/created')
const agent = makeAgent('session-a')
await created({ agent, source: 'startup' })

const status = registeredTools.get('gate_status')
const gateSwitch = registeredTools.get('gate_switch')
assert(status !== undefined, 'gate_status registered')
assert(gateSwitch !== undefined, 'gate_switch registered')

const before = await status.execute({}, { agent })
assert(before.ok === true, 'status ok')
assert(before.groups.length >= 10, 'groups listed')
assert(before.savedBytes === 0, 'nothing hidden initially')
const totalVisible = before.visibleBytes
console.log('status: visible', totalVisible, 'B;', before.groups.length, 'groups')

const off = await gateSwitch.execute({ groups: { ego: false, web: false } }, { agent })
assert(off.ok === true && off.refused.length === 0, 'switch accepted')
assert(off.savedBytes > 0, 'bytes saved')
assert(restrictions.length === 1, `one restriction call after the first hide (got ${restrictions.length})`)
const denied = restrictions.at(-1).deny
assert(denied.includes('ego_click') && denied.includes('web_search'), 'deny list has the group tools')
assert(!denied.includes('read') && !denied.includes('gate_status'), 'core and gate tools stay')

const hiddenNow = tools.view(agent).visible
assert(!hiddenNow.has('ego_click'), 'ego_click hidden')
assert(hiddenNow.has('read'), 'read still visible')

const sessionsFile = join(stateDir, 'sessions.json')
const sessions = JSON.parse(await readFile(sessionsFile, 'utf8'))
assert(sessions.sessions['session-a'].groups.ego === false, 'override persisted')
console.log('switch: saved', off.savedBytes, 'B; persisted to', sessionsFile)

/* hiding another group must not resurrect the groups already hidden */
const more = await gateSwitch.execute({ groups: { office: false } }, { agent })
assert(more.savedBytes > off.savedBytes, 'saved bytes add up without a stale snapshot')
const mergeDeny = restrictions.at(-1).deny
assert(mergeDeny.includes('ego_click') && mergeDeny.includes('web_search'), 'earlier hides stay in the merged deny')
assert(mergeDeny.includes('office_read'), 'new group joined the deny')
const officeBack = await gateSwitch.execute({ groups: { office: true } }, { agent })
assert(tools.view(agent).visible.has('office_read'), 'office tools come back')
assert(!tools.view(agent).visible.has('ego_click'), 'ego stays hidden when only office is restored')
assert(officeBack.savedBytes === off.savedBytes, 'saved bytes return to the two-group figure')
console.log('merge: hide A + hide B, restore B keeps A hidden')

/* human lock beats the agent, and only inside its own session */
await writeFile(
  join(stateDir, 'locks.json'),
  JSON.stringify({ sessions: { 'session-a': { groups: { ego: 'on' } } } }),
  'utf8',
)
const refused = await gateSwitch.execute({ groups: { ego: false } }, { agent })
assert(refused.refused.some((item) => item.id === 'ego'), 'locked group refused')
assert(tools.view(agent).visible.has('ego_click'), 'locked-on group stays visible')
console.log('lock: refused as expected')

const other = makeAgent('session-b')
const otherStatus = await status.execute({}, { agent: other })
const otherEgo = otherStatus.groups.find((item) => item.id === 'ego')
assert(otherEgo.lock === null, 'a lock set in session-a does not appear in session-b')
assert(otherEgo.on === true && otherEgo.locked === false, 'session-b keeps its own state')
console.log('lock: scoped to its session')

/* resume: a fresh agent with the same session id gets the stored overrides */
const resumed = makeAgent('session-a')
await created({ agent: resumed, source: 'resume' })
assert(!tools.view(resumed).visible.has('web_search'), 'stored override reapplied on resume')
assert(tools.view(resumed).visible.has('ego_click'), 'human lock reapplied on resume')

/* gate_plan: keyword recommendation, read-only, and the lock still wins */
const gatePlan = registeredTools.get('gate_plan')
assert(gatePlan !== undefined, 'gate_plan registered')
const emptyPlan = await gatePlan.execute({ task: '   ' }, { agent })
assert(emptyPlan.ok === false, 'plan: empty task refused')
const chatPlan = await gatePlan.execute({ task: '陪我说说话，解释一下 AI' }, { agent })
assert(chatPlan.recipe.id === 'chat', 'plan: chat task picks the chat recipe')
assert(chatPlan.addons.length === 0, 'plan: no add-ons for a plain chat')
assert(chatPlan.groupsOff.includes('ego') === false, 'plan: a locked-on group stays on')
const researchPlan = await gatePlan.execute({ task: '打开浏览器搜一下资料，再发到微信' }, { agent })
assert(researchPlan.recipe.id === 'research', 'plan: search task picks the research recipe')
const addonIds = researchPlan.addons.map((item) => item.id)
assert(addonIds.includes('ego') && addonIds.includes('channels'), 'plan: browser and channels pulled in')
assert(researchPlan.savedBytes > 0 && researchPlan.savedBytes < totalVisible, 'plan: savings inside range')
assert(tools.view(agent).visible.has('read') && !tools.view(agent).visible.has('web_search'), 'plan: applies nothing')
console.log('plan:', chatPlan.recipe.id, '/', researchPlan.recipe.id, '| saved', researchPlan.savedBytes, 'B')

/* all on: restrictions are lifted */
await writeFile(join(stateDir, 'locks.json'), JSON.stringify({ sessions: {} }), 'utf8')
const onAgain = await gateSwitch.execute({ all: true }, { agent })
assert(onAgain.ok === true && onAgain.savedBytes === 0, 'all-on clears the gate')
assert(tools.view(agent).visible.has('ego_click'), 'ego_click back')
console.log('all-on: gate cleared')

function assert(condition, label) {
  if (!condition) {
    console.error('FAIL:', label)
    process.exitCode = 1
    throw new Error(label)
  }
  console.log('ok:', label)
}

console.log('\nsmoke test passed')


