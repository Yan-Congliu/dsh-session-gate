/**
 * dsh-session-gate — per-session tool gate.
 *
 * The tools a session can see are decided per agent by `tools.restrict()`, so
 * hiding a group of tools removes their manuals from every request of that
 * session only. The gate keeps three layers, in order of authority:
 *
 *   locks.json     the person's "always on / always off", PER SESSION:
 *                  {"sessions": {"session-x": {"groups": {"ego": "off"}}}}
 *   sessions.json  per-session overrides, written by `gate_switch`
 *   groups.json    group table + defaults (human editable)
 *
 * A lock only ever covers the session it was set in: clicking 🔒 in one
 * conversation must not decide another. The agent can never write a lock —
 * only the human's panel does, through `setLock` — so a person's decision
 * cannot be overridden by the model.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const inject = ['tools']

const GATE_TOOL_NAMES = new Set(['gate_status', 'gate_switch', 'gate_plan'])

/** Tool groups, matched by exact name first, then by the longest prefix. */
const DEFAULT_GROUPS = [
  {
    id: 'gate',
    name: '闸门自身',
    description: '开关工具的小工具，永远保留，不占多少地方。',
    names: ['gate_status', 'gate_switch', 'gate_plan'],
    switchable: false,
  },
  {
    id: 'web',
    name: '联网查询',
    description: '搜索网页、抓取网页正文。',
    prefixes: ['web_'],
  },
  {
    id: 'ego',
    name: '浏览器自动化',
    description: '用真实/隔离浏览器打开网页、点按钮、填表、截图。占地最大的一组。',
    prefixes: ['ego_'],
  },
  {
    id: 'office',
    name: '办公文档',
    description: '在 Word / Excel / PowerPoint 里读写、排版、渲染文档。',
    prefixes: ['office_'],
  },
  {
    id: 'solidworks',
    name: 'SolidWorks',
    description: '建零件、装配体、工程图，导出模型。',
    prefixes: ['sw_'],
  },
  {
    id: 'board',
    name: '任务看板',
    description: '看板卡片、子任务、定时计划与运行。',
    prefixes: ['task_board_'],
  },
  {
    id: 'team',
    name: '协作团队',
    description: '开同事、发消息、等同事、团队共享任务。',
    names: [
      'spawn_teammate',
      'send_message',
      'list_agents',
      'wait_agent',
      'interrupt_agent',
    ],
    prefixes: ['team_task_'],
  },
  {
    id: 'delegate',
    name: '派活给子代理',
    description: '把独立任务丢给子代理或工作流跑。',
    names: ['subagent', 'subagent_fork', 'workflow', 'list_subagent_models'],
  },
  {
    id: 'memory',
    name: '长期记忆',
    description: '跨会话记忆的读写与人设切换。',
    prefixes: ['memory_'],
    names: ['persona'],
  },
  {
    id: 'channels',
    name: '外部渠道',
    description: '微信 / QQ / 会话切换 / 模型切换 / 通知推送。',
    names: [
      'session_control',
      'qq_session_control',
      'model_control',
      'notify_qq',
      'notify_wechat',
      'send_to_qq',
      'send_to_wechat',
    ],
  },
  {
    id: 'schedule',
    name: '定时任务',
    description: '按 cron 或一次性时间点安排消息。',
    prefixes: ['schedule_'],
  },
  {
    id: 'history',
    name: '历史检索',
    description: '搜旧会话、读旧事件、看会话谱系。',
    names: [
      'session_search',
      'session_event_search',
      'session_event_read',
      'session_event_trace',
      'session_trace',
    ],
  },
  {
    id: 'context',
    name: '上下文压缩',
    description: '压缩、检索、还原对话内容，省上下文用。',
    prefixes: ['acp_', 'context_compression_'],
    names: ['compress', 'decompress', 'search_context'],
  },
  {
    id: 'files',
    name: '文件与命令',
    description: '读写文件、搜索、跑命令、看图片。基本生存工具。',
    names: [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'pwsh',
      'working_directory',
      'read_image',
      'load_workspace_dependencies',
      'apply_patch',
    ],
  },
  {
    id: 'misc',
    name: '杂项',
    description: '后台任务、终端、插件管理、目标、技能、会议。',
    prefixes: ['job_', 'terminal_', 'cordis_', 'plugin_'],
    names: [
      'create_worktree',
      'get_goal',
      'update_goal',
      'process_meeting_media',
      'skill',
      'present',
    ],
  },
  {
    id: 'assist',
    name: '待办与提问',
    description: '会话顶部待办清单 + 遇到选择题先问你；不想要就关掉。',
    names: ['todo_write', 'ask_user_question'],
  },
]

/**
 * One-click combinations offered by the panel. `groups: null` means "every
 * switchable group on". A recipe still respects the person's locks.
 */
const RECIPES = [
  {
    id: 'chat',
    name: '只聊天',
    description: '闸门、记忆、杂项，几乎不占地',
    groups: ['gate', 'memory', 'misc', 'assist'],
  },
  {
    id: 'docs',
    name: '写文档',
    description: '文件 + Office 文档',
    groups: ['gate', 'files', 'office', 'memory', 'misc', 'assist'],
  },
  {
    id: 'research',
    name: '查资料',
    description: '联网 + 浏览器 + 文件',
    groups: ['gate', 'web', 'ego', 'files', 'memory', 'misc', 'assist'],
  },
  {
    id: 'code',
    name: '改代码',
    description: '文件 + 命令 + 上下文压缩',
    groups: ['gate', 'files', 'context', 'memory', 'misc', 'assist'],
  },
  {
    id: 'course',
    name: '跑课设',
    description: '文件 + SolidWorks + 任务看板',
    groups: ['gate', 'files', 'solidworks', 'board', 'memory', 'misc', 'assist'],
  },
  {
    id: 'all',
    name: '全部打开',
    description: '恢复所有组',
    groups: null,
  },
]

/**
 * Keyword rules for `gate_plan`. The recipe with the most hits wins; the
 * add-on rules then pull in groups the task names explicitly ("微信" pulls the
 * channels group into any recipe). Rules are data: edit them here, no logic to
 * touch.
 */
const PLAN_RULES = [
  { recipe: 'course', words: ['课设', 'solidworks', 'sw', '装配', '工程图', '零件', '建模', '仿真', '答辩', '火炮'] },
  {
    recipe: 'research',
    words: ['查', '搜', '资料', '网页', '链接', '新闻', '调研', '研究', '抓取', '网站', '知乎', '百度', '百科'],
  },
  {
    recipe: 'docs',
    words: ['文档', 'word', 'docx', 'excel', '表格', 'ppt', '幻灯片', '演示', '报告', '排版', '写一份', '总结', '简历', '论文'],
  },
  {
    recipe: 'code',
    words: ['代码', 'bug', '报错', '编译', '脚本', '函数', '重构', '测试', 'python', 'javascript', '补丁', 'patch', '仓库'],
  },
  { recipe: 'chat', words: ['聊', '闲聊', '打招呼', '解释', '问问', '翻译', '安慰', '随便说', '想吃什么'] },
]

const ADDON_RULES = [
  { group: 'channels', words: ['微信', 'qq', '邮件', '通知', '发消息', '推送'] },
  { group: 'office', words: ['excel', '表格', 'word', 'ppt', '幻灯片', 'office', 'wps'] },
  { group: 'ego', words: ['浏览器', '截图', '点击', '登录', '填表'] },
  { group: 'board', words: ['看板', '卡片', '子任务', '排期'] },
  { group: 'schedule', words: ['定时', '每天', '每周', 'cron', '提醒'] },
  { group: 'team', words: ['团队', '同事', '并行'] },
  { group: 'delegate', words: ['子代理', '工作流', '派活'] },
  { group: 'history', words: ['历史', '上次', '旧会话', '以前'] },
  { group: 'context', words: ['压缩', '上下文', '省 token'] },
  { group: 'memory', words: ['记忆', '记住', '偏好'] },
  { group: 'solidworks', words: ['solidworks', '三维', '装配体'] },
  { group: 'files', words: ['文件', '路径', '保存', '读一下', '写进', '下载'] },
]

function defaultStateDir() {
  const home = process.env.DSH_HOME?.trim()
  const base = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'session-gate')
}

async function readJson(file, fallback, log) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (cause) {
    if (cause?.code === 'ENOENT') return fallback
    log(`cannot read ${file}: ${String(cause?.message ?? cause)}`)
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

async function ensureJson(file, value) {
  try {
    await readFile(file, 'utf8')
  } catch (cause) {
    if (cause?.code !== 'ENOENT') return
    await writeJson(file, value)
  }
}

function sessionIdOf(agent) {
  const id = agent?.session?.id
  if (typeof id === 'string' && id !== '') return id
  const fallback = agent?.id
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return undefined
}

// Record the byte size of every tool this agent can currently see. A hidden
// tool drops out of `view(agent).visible`, so its size is remembered in `sizes`
// the first time it is measured; `view(agent).restrictableNames` keeps the
// pre-restriction name set, which is what lets a plan restore a group later.
function measureVisible(agent, sizes) {
  const tools = agent.ctx.tools
  try {
    for (const schema of tools.schemas(agent)) {
      const name = typeof schema?.name === 'string' ? schema.name : undefined
      if (name === undefined) continue
      sizes.set(name, JSON.stringify(schema).length)
    }
  } catch {
    /* the gate must not break a status call */
  }
  try {
    for (const [name, definition] of tools.view(agent).visible) {
      if (sizes.has(name)) continue
      sizes.set(
        name,
        JSON.stringify({
          name,
          description: definition?.description,
          parameters: definition?.parameters,
        }).length,
      )
    }
  } catch {
    /* ignored */
  }
}

function buildBuckets(groups, names, byName) {
  const buckets = groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    switchable: group.switchable !== false,
    risky: group.risky === true,
    defaultOn: group.defaultOn !== false,
    countsContext: group.countsContext !== false,
    tools: [],
    bytes: 0,
  }))
  const exact = new Map()
  for (let index = 0; index < groups.length; index += 1) {
    for (const name of groups[index].names ?? []) exact.set(name, index)
  }
  const others = []
  for (const name of names) {
    let index = exact.get(name)
    if (index === undefined) {
      let bestPrefix = ''
      for (let candidate = 0; candidate < groups.length; candidate += 1) {
        for (const prefix of groups[candidate].prefixes ?? []) {
          if (name.startsWith(prefix) && prefix.length > bestPrefix.length) {
            bestPrefix = prefix
            index = candidate
          }
        }
      }
    }
    const bytes = byName.get(name) ?? 0
    if (index === undefined) {
      others.push({ name, bytes })
      continue
    }
    buckets[index].tools.push(name)
    buckets[index].bytes += bytes
  }
  return { buckets, others }
}

function effectiveOn(bucket, group, overrides, locks) {
  const lock = locks?.[group.id]
  if (lock === 'on' || lock === 'off') {
    return { on: lock === 'on', locked: true }
  }
  if (Object.prototype.hasOwnProperty.call(overrides, group.id)) {
    return { on: overrides[group.id] === true, locked: false }
  }
  return { on: group.defaultOn !== false, locked: false }
}

export function apply(ctx, config = {}) {
  const stateDir =
    typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
      ? config.stateDir
      : defaultStateDir()
  const logFile =
    typeof config.logFile === 'string' && config.logFile.trim() !== ''
      ? config.logFile
      : join(stateDir, 'gate.log')
  const groupsFile = join(stateDir, 'groups.json')
  const locksFile = join(stateDir, 'locks.json')
  const sessionsFile = join(stateDir, 'sessions.json')

  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`
    if (logFile !== undefined) {
      void mkdir(dirname(logFile), { recursive: true })
        .then(() => writeFile(logFile, `${line}\n`, { flag: 'a' }))
        .catch(() => {})
    }
    try {
      ctx.logger?.info?.(`session-gate: ${message}`)
    } catch {
      /* ignored */
    }
  }

  const loadGroups = async () => {
    const body = await readJson(groupsFile, undefined, log)
    const list = Array.isArray(body?.groups) && body.groups.length > 0 ? body.groups : DEFAULT_GROUPS
    return list
      .filter((group) => typeof group?.id === 'string' && group.id !== '')
      .map((group) => ({
        id: group.id,
        name: typeof group.name === 'string' ? group.name : group.id,
        description: typeof group.description === 'string' ? group.description : '',
        names: Array.isArray(group.names) ? group.names.filter((name) => typeof name === 'string') : [],
        prefixes: Array.isArray(group.prefixes)
          ? group.prefixes.filter((prefix) => typeof prefix === 'string' && prefix !== '')
          : [],
        switchable: group.switchable !== false,
        risky: group.risky === true,
        defaultOn: group.defaultOn !== false,
        countsContext: group.countsContext !== false,
      }))
  }

  // Locks are per session. An older file kept one global "groups" map, which
  // made a lock leak into every conversation; that shape is ignored (and moved
  // aside at activation) so no session silently inherits it.
  let legacyLockNotice = false
  const loadLocks = async (sessionId) => {
    const body = await readJson(locksFile, { sessions: {} }, log)
    if (body?.sessions === null || typeof body?.sessions !== 'object') {
      if (body?.groups !== undefined && !legacyLockNotice) {
        legacyLockNotice = true
        log('locks.json has the legacy global shape; ignored, locks are per session now')
      }
      return {}
    }
    if (sessionId === undefined) return {}
    const entry = body.sessions[sessionId]
    return entry?.groups !== null && typeof entry?.groups === 'object' ? entry.groups : {}
  }

  const loadSessions = async () => {
    const body = await readJson(sessionsFile, { sessions: {} }, log)
    return body?.sessions !== null && typeof body?.sessions === 'object' ? body.sessions : {}
  }

  const states = new WeakMap()
  // name -> JSON byte length of its model-facing manual. Sizes are filled from
  // the visible view and kept across switches, so hiding one group never loses
  // the measurements another hidden group needs to be restored.
  const sizes = new Map()

  const applyRestriction = (agent, deny) => {
    const previous = states.get(agent)
    try {
      previous?.dispose?.()
    } catch {
      /* a stale effect must not block a new one */
    }
    let dispose
    if (deny.length > 0) dispose = agent.ctx.tools.restrict({ deny })
    states.set(agent, { dispose, deny })
    // Survive a module reload: the WeakMap above is lost when the plugin is
    // replaced, but the restriction effect lives on in the agent scope. Keep a
    // marker on the agent so the next load can release it (releaseStale).
    try {
      if (typeof dispose === 'function') agent.__sessionGateDispose = dispose
      else delete agent.__sessionGateDispose
    } catch {
      /* the agent object may be frozen; the WeakMap still handles this load */
    }
    return deny
  }

  // Called once per activation: a previous load of this plugin may have left a
  // restriction on live agents that its WeakMap can no longer reach. Releasing
  // it makes a reloaded plugin see (and measure) the full catalog again.
  const releaseStale = () => {
    const agents = ctx.get?.('agents', false)
    for (const agent of agents?.list?.() ?? []) {
      const dispose = agent?.__sessionGateDispose
      if (typeof dispose !== 'function') continue
      try {
        dispose()
      } catch {
        /* already disposed */
      }
      try {
        delete agent.__sessionGateDispose
      } catch {
        /* frozen */
      }
      log(`released a restriction left by a previous load (session=${sessionIdOf(agent) ?? '?'})`)
    }
  }

  const planFor = async (agent) => {
    const groups = await loadGroups()
    const sessions = await loadSessions()
    const sessionId = sessionIdOf(agent)
    const locks = await loadLocks(sessionId)
    const stored = sessionId === undefined ? undefined : sessions[sessionId]
    const overrides = stored?.groups !== null && typeof stored?.groups === 'object' ? stored.groups : {}

    const view = agent.ctx.tools.view(agent)
    const restrictable = view.restrictableNames
    measureVisible(agent, sizes)
    const names = [...new Set([...restrictable, ...view.visible.keys()])].sort()
    const byName = new Map(names.map((name) => [name, sizes.get(name) ?? 0]))
    const total = names.reduce((sum, name) => sum + byName.get(name), 0)
    const { buckets, others } = buildBuckets(groups, names, byName)

    let savedBytes = 0
    const deny = []
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index]
      const group = groups[index]
      const { on, locked } = effectiveOn(bucket, group, overrides, locks)
      bucket.on = on
      bucket.locked = locked
      if (on || !bucket.switchable) continue
      for (const name of bucket.tools) {
        if (GATE_TOOL_NAMES.has(name) || !restrictable.has(name)) continue
        deny.push(name)
        savedBytes += byName.get(name) ?? 0
      }
    }
    const otherBytes = others.reduce((sum, item) => sum + item.bytes, 0)
    return {
      sessionId,
      groups,
      buckets,
      others,
      overrides,
      locks,
      deny,
      savedBytes,
      visibleBytes: Math.max(0, total - savedBytes),
      otherBytes,
      restrictable,
      byName,
    }
  }

  const describe = (plan) => ({
    ok: true,
    sessionId: plan.sessionId ?? null,
    visibleBytes: plan.visibleBytes,
    estimateTokens: Math.round(plan.visibleBytes / 4),
    savedBytes: plan.savedBytes,
    savedTokens: Math.round(plan.savedBytes / 4),
    groups: plan.buckets.map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      description: bucket.description,
      on: bucket.on,
      locked: bucket.locked,
      lock: plan.locks?.[bucket.id] === 'on' || plan.locks?.[bucket.id] === 'off' ? plan.locks[bucket.id] : null,
      switchable: bucket.switchable,
      countsContext: bucket.countsContext,
      risky: bucket.risky,
      toolCount: bucket.tools.length,
      bytes: bucket.bytes,
      tokens: Math.round(bucket.bytes / 4),
    })),
    other: {
      toolCount: plan.others.length,
      bytes: plan.otherBytes,
      tokens: Math.round(plan.otherBytes / 4),
      sample: plan.others.slice(0, 12).map((item) => item.name),
    },
  })

  // gate_plan: score the task text against the keyword rules, take the recipe
  // with the most hits, then add groups the task names explicitly. Pure
  // estimate — it applies nothing and never changes a lock.
  const recommend = (task, plan) => {
    const raw = String(task ?? '').trim()
    if (raw === '') return { ok: false, error: 'need a task description, e.g. {"task":"写一份课设报告"}' }
    const text = raw.toLowerCase()
    const hits = (words) => words.filter((word) => text.includes(word))
    let best
    for (const rule of PLAN_RULES) {
      const matched = hits(rule.words)
      if (matched.length === 0) continue
      if (best === undefined || matched.length > best.matched.length) best = { recipe: rule.recipe, matched }
    }
    const addons = []
    for (const rule of ADDON_RULES) {
      const matched = hits(rule.words)
      if (matched.length > 0) addons.push({ id: rule.group, matched })
    }
    const recipe = best === undefined ? RECIPES[0] : (RECIPES.find((item) => item.id === best.recipe) ?? RECIPES[0])
    const wanted = new Set(recipe.groups ?? [])
    for (const addon of addons) wanted.add(addon.id)

    const totalBytes = plan.visibleBytes + plan.savedBytes
    let savedBytes = 0
    const groups = plan.buckets.map((bucket) => {
      const lock = plan.locks?.[bucket.id] === 'on' || plan.locks?.[bucket.id] === 'off' ? plan.locks[bucket.id] : null
      let on
      if (!bucket.switchable) on = true
      else if (lock === 'on') on = true
      else if (lock === 'off') on = false
      else on = wanted.has(bucket.id)
      if (!on) {
        for (const name of bucket.tools) {
          if (!plan.restrictable.has(name)) continue
          savedBytes += plan.byName.get(name) ?? 0
        }
      }
      return { id: bucket.id, name: bucket.name, on, locked: lock !== null, lock, bytes: bucket.bytes }
    })
    const visibleBytes = Math.max(0, totalBytes - savedBytes)
    const switchGroups = {}
    for (const bucket of plan.buckets) {
      if (bucket.switchable) switchGroups[bucket.id] = wanted.has(bucket.id)
    }
    return {
      ok: true,
      task: raw,
      recipe: { id: recipe.id, name: recipe.name, description: recipe.description },
      matched: best?.matched ?? [],
      addons: addons.map((addon) => ({ id: addon.id, matched: addon.matched })),
      guessed: best === undefined,
      groupsOn: groups.filter((group) => group.on).map((group) => group.id),
      groupsOff: groups.filter((group) => !group.on).map((group) => group.id),
      switch: { groups: switchGroups },
      totalBytes,
      visibleBytes,
      estimateTokens: Math.round(visibleBytes / 4),
      savedBytes,
      savedTokens: Math.round(savedBytes / 4),
      locked: groups.filter((group) => group.locked).map((group) => ({ id: group.id, lock: group.lock })),
      note: '只给建议、不自动执行。认可就 gate_switch {"groups": ...}；锁住的组不会动。',
    }
  }

  const refresh = async (agent) => {
    const plan = await planFor(agent)
    applyRestriction(agent, plan.deny)
    return plan
  }

  let chain = Promise.resolve()
  const serialize = (work) => {
    const run = chain.then(work, work)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const RECIPE_SETS = new Map(
    RECIPES.filter((recipe) => recipe.groups !== null).map((recipe) => [recipe.id, new Set(recipe.groups)]),
  )

  // Shared by the agent tools and the panel API: evaluate a request against the
  // plan, respect the person's locks, persist the per-session choice, then
  // re-apply the restriction.
  const applySwitch = async (agent, request = {}) => {
    const plan = await planFor(agent)
    const locks = plan.locks ?? {}
    const requested = {}
    let recipeLabel = ''
    if (typeof request.recipe === 'string') {
      const recipe = RECIPES.find((candidate) => candidate.id === request.recipe)
      if (recipe === undefined) return { ok: false, error: `unknown recipe "${request.recipe}"` }
      for (const bucket of plan.buckets) {
        if (!bucket.switchable) continue
        requested[bucket.id] = recipe.groups === null ? true : RECIPE_SETS.get(recipe.id).has(bucket.id)
      }
      recipeLabel = recipe.name
    }
    if (request.all !== undefined) {
      for (const bucket of plan.buckets) {
        if (bucket.switchable) requested[bucket.id] = request.all === true
      }
    }
    if (request.groups !== null && typeof request.groups === 'object') {
      for (const [id, value] of Object.entries(request.groups)) requested[id] = value === true
    }
    if (Object.keys(requested).length === 0) {
      return { ok: false, error: 'nothing requested: pass groups, all or recipe' }
    }

    const refused = []
    const accepted = {}
    for (const [id, value] of Object.entries(requested)) {
      const bucket = plan.buckets.find((candidate) => candidate.id === id)
      if (bucket === undefined) {
        refused.push({ id, reason: 'unknown group' })
        continue
      }
      if (!bucket.switchable) {
        refused.push({ id, reason: 'this group is always available' })
        continue
      }
      const lock = locks?.[id]
      if (lock === 'on' || lock === 'off') {
        refused.push({ id, reason: `locked by the person to "${lock}"` })
        continue
      }
      accepted[id] = value
    }

    const changed = Object.entries(accepted).filter(
      ([id, value]) => plan.buckets.find((bucket) => bucket.id === id)?.on !== value,
    )
    if (Object.keys(accepted).length > 0) {
      if (plan.sessionId === undefined) {
        refused.push({ id: '*', reason: 'no session id: change applied for now but not persisted' })
      } else {
        const sessions = await loadSessions()
        const previous =
          sessions[plan.sessionId]?.groups !== null && typeof sessions[plan.sessionId]?.groups === 'object'
            ? sessions[plan.sessionId].groups
            : {}
        sessions[plan.sessionId] = {
          groups: { ...previous, ...accepted },
          updatedAt: new Date().toISOString(),
        }
        await writeJson(sessionsFile, { sessions })
      }
    }

    const after = await refresh(agent)
    const prefix = recipeLabel === '' ? '' : `${recipeLabel}：`
    return {
      ...describe(after),
      changed: changed.map(([id, value]) => ({ id, on: value })),
      refused,
      note:
        changed.length > 0
          ? `${prefix}工具集已变：本会话的 prompt 缓存会作废，后续步骤重新计费；建议在阶段边界切换。`
          : `${prefix}工具集没有变化。`,
    }
  }

  // The only writer of locks.json: the human's panel. A lock covers exactly the
  // session it was set in, never another conversation.
  const setLock = async (sessionId, groupId, state) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, error: 'missing session: a lock only applies to one session' }
    }
    const groups = await loadGroups()
    if (!groups.some((group) => group.id === groupId)) return { ok: false, error: `unknown group "${groupId}"` }
    if (state !== 'on' && state !== 'off' && state !== null) {
      return { ok: false, error: 'state must be "on", "off" or null' }
    }
    const body = await readJson(locksFile, { sessions: {} }, log)
    const all = body?.sessions !== null && typeof body?.sessions === 'object' ? { ...body.sessions } : {}
    const current =
      all[sessionId]?.groups !== null && typeof all[sessionId]?.groups === 'object' ? all[sessionId].groups : {}
    const next = { ...current }
    if (state === null) delete next[groupId]
    else next[groupId] = state
    if (Object.keys(next).length === 0) delete all[sessionId]
    else all[sessionId] = { groups: next, updatedAt: new Date().toISOString() }
    await writeJson(locksFile, { sessions: all })
    log(`lock session=${sessionId} group=${groupId} state=${state ?? 'cleared'}`)
    return { ok: true, session: sessionId, locks: next }
  }

  const readBody = async (request) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 65536) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    return text.trim() === '' ? {} : JSON.parse(text)
  }

  const replyJson = (response, status, value) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(`${JSON.stringify(value)}\n`)
  }

  // The bundle version, read once from our own package.json. Issues are much
  // easier to place when the reporter can paste it with gate_status output.
  let bundleVersionCache
  const bundleVersion = async () => {
    if (bundleVersionCache !== undefined) return bundleVersionCache
    try {
      const own = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      bundleVersionCache = typeof own?.version === 'string' ? own.version : 'unknown'
    } catch {
      bundleVersionCache = 'unknown'
    }
    return bundleVersionCache
  }

  // Live sessions, with what each currently reports. Used by `/sessions` and by
  // the "which session do you mean?" lists the panel shows instead of dying.
  const liveRows = async (agents) => {
    const rows = []
    for (const agent of agents?.list?.() ?? []) {
      try {
        const plan = await planFor(agent)
        rows.push({
          id: agent.session?.id ?? null,
          title: agent.session?.title ?? null,
          preset: agent.presetId ?? agent.preset?.id ?? null,
          visibleBytes: plan.visibleBytes,
          savedBytes: plan.savedBytes,
        })
      } catch (error) {
        rows.push({ id: agent.session?.id ?? null, error: String(error?.message ?? error) })
      }
    }
    return rows
  }

  // The panel talks to the Host through this loopback-only API. Every mutation
  // goes through applySwitch/setLock — the same code the agent tools call — so a
  // rule is implemented exactly once.
  //
  // Reads may be relaxed, writes may not:
  //   GET /state   no session + exactly one live session → answer for that one and
  //                say `fallback: true`, so a panel that never got a session id
  //                still works instead of showing an empty box.
  //   GET /state   otherwise → `offline` plus the live `sessions[]` to pick from.
  //   POST ...     always needs an explicit `session`: the panel can be mounted on
  //                a dormant session while another one is the only live agent, and
  //                a silent fallback would then change the wrong conversation.
  const gateApi = async (request, response) => {
    const remote = request.socket?.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback) {
      replyJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://session-gate.local')
    const method = url.pathname.startsWith('/session-gate/api/')
      ? url.pathname.slice('/session-gate/api/'.length)
      : ''
    const agents = ctx.get?.('agents', false)
    try {
      if (method === 'sessions' && request.method === 'GET') {
        // Diagnostic: which live agents the gate can see, and what each reports.
        const rows = await liveRows(agents)
        replyJson(response, 200, { ok: true, version: await bundleVersion(), sessions: rows })
        return
      }
      if (method === 'state' && request.method === 'GET') {
        // `sessionId` is accepted as an input alias only; the response always
        // carries `sessionId`, so a caller never has to know which name it sent.
        const requested = url.searchParams.get('session') ?? url.searchParams.get('sessionId') ?? ''
        let sessionId = requested
        let fallback = false
        let agent = sessionId === '' ? undefined : agents?.get?.(sessionId)
        if (agent === undefined) {
          const rows = await liveRows(agents)
          if (sessionId === '' && rows.length === 1 && rows[0].id !== null) {
            agent = agents?.get?.(rows[0].id)
            if (agent !== undefined) {
              sessionId = rows[0].id
              fallback = true
            }
          }
          if (agent === undefined) {
            const error =
              rows.length === 0
                ? '现在没有运行中的会话；先打开或切回一个会话，闸门才有东西可管。'
                : sessionId === ''
                  ? `面板没拿到会话 id，而现在有 ${rows.length} 个会话在运行；从下面挑一个接上。`
                  : '这个会话当前不在运行；先切回该会话，闸门才能改它的工具。'
            replyJson(response, 200, {
              ok: false,
              offline: true,
              error,
              requestedSession: sessionId === '' ? null : sessionId,
              sessions: rows,
              version: await bundleVersion(),
              hint: 'GET /session-gate/api/state?session=<id>',
            })
            return
          }
        }
        const plan = await planFor(agent)
        replyJson(response, 200, {
          ...describe(plan),
          recipes: RECIPES,
          live: true,
          fallback,
          requestedSession: requested === '' ? null : requested,
          version: await bundleVersion(),
        })
        return
      }
      if (request.method !== 'POST') {
        replyJson(response, 404, { ok: false, error: 'unknown path' })
        return
      }
      const body = await readBody(request)
      const agent = agents?.get?.(typeof body.session === 'string' ? body.session : '')
      if (method === 'lock') {
        const sessionId = typeof body.session === 'string' ? body.session : ''
        const result = await serialize(() =>
          setLock(sessionId, body.group, body.state === undefined ? null : body.state),
        )
        if (result.ok !== false && agent !== undefined) {
          result.state = describe(await refresh(agent))
        }
        replyJson(response, result.ok === false ? 400 : 200, result)
        return
      }
      if (method === 'plan') {
        if (agent === undefined) {
          replyJson(response, 409, {
            ok: false,
            offline: true,
            error: '这个会话当前不在运行；先切回该会话。',
            sessions: await liveRows(agents),
          })
          return
        }
        const plan = await planFor(agent)
        const result = recommend(body.task, plan)
        replyJson(response, result.ok === false ? 400 : 200, result)
        return
      }
      if (method === 'switch') {
        if (agent === undefined) {
          replyJson(response, 409, {
            ok: false,
            offline: true,
            error: '这个会话当前不在运行；先切回该会话。',
            sessions: await liveRows(agents),
          })
          return
        }
        const result = await serialize(() => applySwitch(agent, body))
        replyJson(response, result.ok === false ? 400 : 200, result)
        return
      }
      replyJson(response, 404, { ok: false, error: 'unknown api method' })
    } catch (error) {
      log(`api failed: ${String(error?.stack ?? error)}`)
      try {
        replyJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        /* the response may already be gone */
      }
    }
  }

  const registerHttp = () => {
    const attach = (scope, webServer) => {
      if (webServer === undefined || webServer === null) {
        log('webServer unavailable: panel api disabled')
        return
      }
      try {
        scope.effect(
          () => webServer.register({ kind: 'prefix', path: '/session-gate/api', handler: gateApi }),
          'session-gate: http api',
        )
        log('http api ready at /session-gate/api')
      } catch (error) {
        log(`http api registration failed: ${String(error?.message ?? error)}`)
      }
    }
    // On a cold start the web server may activate after this plugin: wait for the
    // service instead of probing once, or the panel loses its API until a reload.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        attach(scoped, scoped.get?.('webServer', false))
      })
      return
    }
    attach(ctx, ctx.get?.('webServer', false))
  }

  const statusTool = {
    name: 'gate_status',
    description: 'List this session\'s tool groups: on/off, human lock, token cost. Read-only.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec?.agent
      if (agent === undefined) return { ok: false, error: 'called without an agent' }
      return serialize(async () => {
        const plan = await refresh(agent)
        const body = describe(plan)
        body.stateDir = stateDir
        body.bundleVersion = await bundleVersion()
        log(
          `status session=${plan.sessionId ?? '?'} visible=${plan.visibleBytes}B saved=${plan.savedBytes}B denied=${plan.deny.length}`,
        )
        return body
      })
    },
  }

  const switchTool = {
    name: 'gate_switch',
    description:
      'Show/hide tool groups in this session: {"groups":{"ego":false}}, {"all":true} or {"recipe":"chat"}. ' +
      'Hidden groups stop sending their tool manuals; switching voids the prompt cache.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groups: { type: 'object', additionalProperties: { type: 'boolean' } },
        all: { type: 'boolean' },
        recipe: { type: 'string', enum: RECIPES.map((recipe) => recipe.id) },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) return { ok: false, error: 'called without an agent' }
      return serialize(async () => {
        const result = await applySwitch(agent, args ?? {})
        if (result.ok === false) return result
        log(
          `switch session=${result.sessionId ?? '?'} changed=${result.changed.map((item) => `${item.id}:${item.on}`).join(',') || '-'} saved=${result.savedBytes}B`,
        )
        return result
      })
    },
  }

  const planTool = {
    name: 'gate_plan',
    description:
      'Recommend which tool groups to keep for a task and how much context that saves (read-only; apply with gate_switch).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string' },
      },
      required: ['task'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) return { ok: false, error: 'called without an agent' }
      return serialize(async () => {
        const plan = await planFor(agent)
        const result = recommend(args?.task, plan)
        if (result.ok === true) {
          log(
            `plan session=${plan.sessionId ?? '?'} recipe=${result.recipe.id} addons=${result.addons.map((item) => item.id).join(',') || '-'} saved=${result.savedBytes}B`,
          )
        }
        return result
      })
    },
  }

  ctx.tools.register(statusTool)
  ctx.tools.register(switchTool)
  ctx.tools.register(planTool)
  registerHttp()

  ctx.on('agent/created', async (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    try {
      const plan = await planFor(agent)
      applyRestriction(agent, plan.deny)
      log(
        `agent/created session=${plan.sessionId ?? '?'} source=${String(payload?.source ?? '?')} visible=${plan.visibleBytes}B saved=${plan.savedBytes}B denied=${plan.deny.length}`,
      )
    } catch (cause) {
      log(`agent/created failed: ${String(cause?.stack ?? cause)}`)
    }
  })

  void (async () => {
    try {
      await mkdir(stateDir, { recursive: true })
      await ensureJson(groupsFile, { groups: DEFAULT_GROUPS })
      await ensureJson(sessionsFile, { sessions: {} })
      // A pre-0.2.1 locks.json held one global map: keep it for the record but
      // do not let it decide any session.
      const locks = await readJson(locksFile, undefined, log)
      if (locks !== undefined && locks?.groups !== undefined && locks?.sessions === undefined) {
        const backup = join(stateDir, `locks.legacy-${Date.now()}.json`)
        await rename(locksFile, backup).catch(() => {})
        log(`legacy global locks moved to ${backup}`)
      }
      await ensureJson(locksFile, { sessions: {} })
      releaseStale()
      log(`activated stateDir=${stateDir}`)
    } catch (cause) {
      log(`state init failed: ${String(cause?.stack ?? cause)}`)
    }
  })()
}
