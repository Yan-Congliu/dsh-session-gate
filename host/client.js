window.__ModuleLoader__.load({
  id: 'dsh-session-gate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PKG = 'dsh-session-gate'
    const KIND = 'session-gate:panel'
    const API = '/session-gate/api'

    const STYLES = `
.dsg-root { display:flex; flex-direction:column; gap:10px; padding:12px 12px 18px; height:100%; overflow:auto;
  box-sizing:border-box; font-size:12px; color:var(--dsw-alias-label-primary); }
.dsg-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.dsg-title { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsg-stat { color:var(--dsw-alias-state-idle-primary); font-size:11px; }
.dsg-saved { color:var(--dsw-alias-state-success-primary); font-size:11px; font-weight:600; }
.dsg-recipes { display:flex; flex-wrap:wrap; gap:6px; }
.dsg-recipe { border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary);
  font-size:11px; border-radius:999px; padding:3px 9px; cursor:pointer; transition:background .18s ease; }
.dsg-recipe:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dsg-recipe:disabled { opacity:.45; cursor:default; }
.dsg-group { display:flex; flex-direction:column; gap:6px; }
.dsg-row { display:flex; align-items:flex-start; gap:8px; padding:7px 8px; border-radius:8px;
  border:1px solid transparent; transition:background .18s ease; }
.dsg-row:hover { background:var(--dsw-alias-bg-layer-2); }
.dsg-row-off .dsg-name, .dsg-row-off .dsg-desc { opacity:.55; }
.dsg-row-locked { border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
.dsg-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.dsg-line { display:flex; align-items:baseline; gap:6px; min-width:0; }
.dsg-name { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); white-space:nowrap; }
.dsg-badge { font-size:11px; font-weight:600; color:var(--dsw-alias-state-warn-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); border-radius:4px; padding:0 4px; }
.dsg-tokens { margin-left:auto; color:var(--dsw-alias-state-idle-primary); font-size:11px; white-space:nowrap; }
.dsg-desc { color:var(--dsw-alias-state-idle-primary); font-size:11px; line-height:1.55;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsg-zero .dsg-tokens { color:var(--dsw-alias-label-secondary); opacity:.7; }
.dsg-lock { flex:none; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary);
  font-size:11px; border-radius:6px; padding:2px 5px; cursor:pointer; white-space:nowrap; transition:color .18s ease; }
.dsg-lock:hover:not(:disabled) { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
.dsg-lock-on { color:var(--dsw-alias-state-warn-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.dsg-switch { flex:none; width:32px; height:18px; padding:0; border:0; background:transparent; cursor:pointer; position:relative; }
.dsg-switch:disabled { opacity:.4; cursor:default; }
.dsg-track { display:block; width:32px; height:18px; border-radius:9px;
  background:color-mix(in srgb, var(--dsw-alias-label-secondary) 25%, transparent); transition:background .18s ease; }
.dsg-thumb { position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
  background:var(--dsw-alias-bg-base, #fff); transition:transform .18s ease; }
.dsg-switch[aria-checked="true"] .dsg-track { background:var(--dsw-alias-state-success-primary); }
.dsg-switch[aria-checked="true"] .dsg-thumb { transform:translateX(14px); }
.dsg-section { display:flex; align-items:center; gap:6px; margin-top:2px;
  font-size:11px; font-weight:600; color:var(--dsw-alias-state-idle-primary); letter-spacing:.04em; }
.dsg-hint { font-size:11px; color:var(--dsw-alias-state-idle-primary); line-height:1.7; }
.dsg-error { font-size:11px; color:var(--dsw-alias-state-error-primary); line-height:1.7;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); border-radius:8px; padding:6px 8px; }
.dsg-note { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.7; }
.dsg-empty { color:var(--dsw-alias-label-secondary); opacity:.7; font-size:11px; padding:12px 0; }
`

    const fmtBytes = (bytes) => {
      const value = typeof bytes === 'number' ? bytes : 0
      if (value < 1024) return `${value} B`
      return `${(value / 1024).toFixed(1)} KB`
    }
    const fmtTokens = (tokens) => {
      const value = typeof tokens === 'number' ? tokens : 0
      if (value < 1000) return `${value}`
      return `${(value / 1000).toFixed(1)}K`
    }

    const post = async (method, body) => {
      const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.json()
    }

    function Row(props) {
      const { group, busy, onSwitch, onLock } = props
      const locked = group.lock === 'on' || group.lock === 'off'
      const zero = group.countsContext === false || group.bytes === 0
      const classes = ['dsg-row']
      if (!group.on) classes.push('dsg-row-off')
      if (locked) classes.push('dsg-row-locked')
      if (zero) classes.push('dsg-zero')
      const lockLabel = locked ? (group.lock === 'on' ? '🔒常开' : '🔒常关') : '🔓'
      return h(
        'div',
        { className: classes.join(' ') },
        h(
          'div',
          { className: 'dsg-main' },
          h(
            'div',
            { className: 'dsg-line' },
            h('span', { className: 'dsg-name' }, group.name),
            group.risky ? h('span', { className: 'dsg-badge' }, '谨慎') : null,
            h(
              'span',
              { className: 'dsg-tokens' },
              group.toolCount === 0
                ? '本会话没装'
                : zero
                  ? '0 token'
                  : `${fmtBytes(group.bytes)} · ≈${fmtTokens(group.tokens)} token`,
            ),
          ),
          h('div', { className: 'dsg-desc', title: group.description }, group.description),
        ),
        h(
          'button',
          {
            className: locked ? 'dsg-lock dsg-lock-on' : 'dsg-lock',
            disabled: busy || !group.switchable,
            title: locked
              ? '你设了“始终开/始终关”，点一下解锁'
              : '点一下锁定：按现在状态“始终开/始终关”，AI 改不动',
            onClick: () => onLock(group),
          },
          lockLabel,
        ),
        h(
          'button',
          {
            className: 'dsg-switch',
            role: 'switch',
            'aria-checked': group.on ? 'true' : 'false',
            'aria-label': `${group.name}：${group.on ? '开' : '关'}`,
            disabled: busy || !group.switchable || locked || zero,
            title: group.switchable ? (locked ? '已被人锁定' : group.on ? '关掉，省 token' : '打开') : '这一组始终可用',
            onClick: () => onSwitch(group),
          },
          h('span', { className: 'dsg-track' }, h('span', { className: 'dsg-thumb' })),
        ),
      )
    }

    function GatePanel(props) {
      const sessionId = props.sessionId
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const visible = info?.tab?.visible !== false
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(
        async (quiet) => {
          if (typeof sessionId !== 'string' || sessionId === '') return
          try {
            const response = await fetch(`${API}/state?session=${encodeURIComponent(sessionId)}`, {
              headers: { accept: 'application/json' },
            })
            const body = await response.json()
            if (!alive.current) return
            if (body?.ok === false) {
              setError(body.error ?? '读取失败')
              if (body.groups) setState(body)
            } else {
              setError(null)
              setState(body)
            }
          } catch (cause) {
            if (alive.current && quiet !== true) setError(`连不上闸门服务：${String(cause?.message ?? cause)}`)
          }
        },
        [sessionId],
      )

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        if (!visible) return undefined
        const timer = setInterval(() => void load(true), 5000)
        return () => clearInterval(timer)
      }, [visible, load])

      const run = useCallback(
        async (work) => {
          if (busy) return
          setBusy(true)
          setNote('')
          try {
            const body = await work()
            if (!alive.current) return
            if (body?.ok === false) {
              setError(body.error ?? '操作被拒绝')
            } else {
              setError(null)
              if (body?.state) setState(body.state)
              else if (Array.isArray(body?.groups)) setState(body)
              if (body?.note) setNote(body.note)
              if (Array.isArray(body?.refused) && body.refused.length > 0) {
                setNote(
                  (previous) =>
                    `${previous}${previous === '' ? '' : ' '}被拒绝：${body.refused
                      .map((item) => `${item.id}（${item.reason}）`)
                      .join('，')}`,
                )
              }
            }
          } catch (cause) {
            if (alive.current) setError(`操作失败：${String(cause?.message ?? cause)}`)
          } finally {
            if (alive.current) setBusy(false)
          }
        },
        [busy],
      )

      const onSwitch = useCallback(
        (group) => {
          void run(() =>
            post('switch', { session: sessionId, groups: { [group.id]: group.on !== true } }),
          )
        },
        [run, sessionId],
      )
      const onLock = useCallback(
        (group) => {
          const state = group.lock === 'on' || group.lock === 'off' ? null : group.on ? 'on' : 'off'
          void run(() => post('lock', { session: sessionId, group: group.id, state }))
        },
        [run, sessionId],
      )
      const onRecipe = useCallback(
        (recipe) => {
          void run(() => post('switch', { session: sessionId, recipe: recipe.id }))
        },
        [run, sessionId],
      )

      const ordered = useMemo(() => {
        const groups = Array.isArray(state?.groups) ? state.groups.slice() : []
        return groups.sort((left, right) => {
          const leftZero = left.countsContext === false || left.bytes === 0 ? 1 : 0
          const rightZero = right.countsContext === false || right.bytes === 0 ? 1 : 0
          if (leftZero !== rightZero) return leftZero - rightZero
          return (right.bytes ?? 0) - (left.bytes ?? 0)
        })
      }, [state])

      const rawSession = String(state?.sessionId ?? sessionId ?? '')
      const shortSession =
        rawSession.startsWith('session-') && rawSession.length > 16
          ? rawSession.slice(8, 16)
          : rawSession.slice(0, 8)

      if (typeof sessionId !== 'string' || sessionId === '') {
        return h('div', { className: 'dsg-root' }, h('div', { className: 'dsg-empty' }, '请先打开一个会话'))
      }

      return h(
        'div',
        { className: 'dsg-root' },
        h(
          'div',
          { className: 'dsg-head' },
          h('span', { className: 'dsg-title' }, '会话闸门'),
          state
            ? h(
                'span',
                {
                  className: 'dsg-stat',
                  title: `会话 ${String(state.sessionId ?? sessionId)}｜开关和锁只对这个会话生效`,
                },
                `工具说明 ${fmtBytes(state.visibleBytes)} ≈ ${fmtTokens(state.estimateTokens)} token · 本会话 ${shortSession}`,
              )
            : h('span', { className: 'dsg-stat' }, '读取中…'),
          state && state.savedTokens > 0
            ? h(
                'span',
                { className: 'dsg-saved', title: `总工具说明 ${fmtBytes(state.savedBytes + state.visibleBytes)}，关掉的占 ${Math.round((state.savedTokens / Math.max(1, state.savedTokens + state.estimateTokens)) * 100)}%` },
                `已省 ≈${fmtTokens(state.savedTokens)} token（${Math.round((state.savedTokens / Math.max(1, state.savedTokens + state.estimateTokens)) * 100)}%）`,
              )
            : null,
        ),
        state?.recipes?.length
          ? h(
              'div',
              { className: 'dsg-recipes' },
              state.recipes.map((recipe) =>
                h(
                  'button',
                  {
                    key: recipe.id,
                    className: 'dsg-recipe',
                    title: recipe.description,
                    disabled: busy,
                    onClick: () => onRecipe(recipe),
                  },
                  recipe.name,
                ),
              ),
            )
          : null,
        error ? h('div', { className: 'dsg-error' }, error) : null,
        note ? h('div', { className: 'dsg-note' }, note) : null,
        h(
          'div',
          { className: 'dsg-section' },
          '工具组',
          h('span', { className: 'dsg-hint' }, ordered.length ? `${ordered.length} 组` : ''),
        ),
        ordered.length === 0
          ? h('div', { className: 'dsg-empty' }, error ? '' : '还没有读到工具组')
          : h(
              'div',
              { className: 'dsg-group' },
              ordered.map((group) =>
                h(Row, { key: group.id, group, busy, onSwitch, onLock }),
              ),
              state?.other?.toolCount > 0
                ? h(
                    'div',
                    { className: 'dsg-row dsg-zero' },
                    h(
                      'div',
                      { className: 'dsg-main' },
                      h(
                        'div',
                        { className: 'dsg-line' },
                        h('span', { className: 'dsg-name' }, '其他'),
                        h(
                          'span',
                          { className: 'dsg-tokens' },
                          `${state.other.toolCount} 个 · ${fmtBytes(state.other.bytes)}`,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dsg-desc' },
                        `还没归组的工具（${(state.other.sample ?? []).join('、')}…）`,
                      ),
                    ),
                  )
                : null,
            ),
        h(
          'div',
          { className: 'dsg-hint' },
          '🔒 是你设的“始终开/始终关”，AI 改不动。开关只影响本会话，别的会话不受影响；“本会话没装”表示这个会话里压根没加载那组工具，不算省下来的。改工具集会让本会话的 prompt 缓存作废，建议在阶段边界切。',
        ),
      )
    }

    function GateTabBody(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      return h(GatePanel, { sessionId: props.sessionId, visible: info?.tab?.visible !== false })
    }

    function GateTabTitle(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      return h('span', null, info?.tab?.title ?? '会话闸门')
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined' || document.head === undefined) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-dsh-session-gate', 'styles')
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => {
            if (style.parentNode) style.parentNode.removeChild(style)
          }
        }, 'session-gate: styles')
        const tabs = ctx.get('sidebarRightTabs', false)
        const slots = ctx.get('slots', false)
        if (tabs === undefined || tabs === null || slots === undefined || slots === null) return
        ctx.effect(
          () =>
            tabs.register({
              id: PKG,
              kind: KIND,
              title: () => '会话闸门',
              guide: [{ id: PKG, order: 40, title: () => '会话闸门' }],
            }),
          'session-gate: tab type',
        )
        ctx.effect(
          () =>
            slots.inject('sidebar.right.pane.tab', () =>
              slots.register({ name: 'sidebar.right.pane.tab', key: PKG }, GateTabBody),
            ),
          'session-gate: tab body',
        )
        ctx.effect(
          () =>
            slots.inject('sidebar.right.pane.tab.title', () =>
              slots.register({ name: 'sidebar.right.pane.tab.title', key: PKG }, GateTabTitle),
            ),
          'session-gate: tab title',
        )
      },
    }
  },
})
