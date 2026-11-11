# 阶段 2 报告：可视化面板 + `local` 本地模式预设

日期：2026-11-10 21:40 起｜版本：`@local/dsh-session-gate` 0.2.0

## 做了什么

1. **右侧栏面板**（`host/client.js`，无构建，`window.__ModuleLoader__` 直接加载）
   - 页签类型 `session-gate:panel`，标题「会话闸门」，`sidebarRightTabs` 注册；
     body / title 分别挂到 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title`（key = 包名）。
   - 内容：总计字节/token、已省量、6 个配方按钮、每组一行（名称 + 「谨慎」徽章 + 字节/token +
     描述 + 🔓 锁按钮 + 开关）；`0 token` 组自动置底且开关置灰。
   - 双向：5s 轮询 `/session-gate/api/state`，操作走 `/switch`、`/lock`。
2. **Host HTTP API**（`index.js` 的 `gateApi` / `registerHttp`）
   - 前缀 `webServer.register({kind:'prefix', path:'/session-gate/api'})`，仅接受 127.0.0.1/::1。
   - `GET /state?session=`；`POST /switch`（groups/all/recipe）；`POST /lock`（on/off/null）。
   - 与 agent 工具共用 `applySwitch` / `setLock`，规则只实现一遍（`user-actions.md` 的要求）。
3. **配方 RECIPES**：chat / docs / research / code / course / all，工具与面板都能用 `recipe` 一键切。
4. **`local` 预设**：`cordis.patch.yml` 第二条 insert 行声明
   `@deepseek-ai/dsh-agent-preset` 的 `{id: local, name: 本地模式, order: 4}`，
   plugins = persona（短前缀，complete，不带 runtime context）+ tool-fs（read/write/edit，无 readImage）
   + tool-pwsh（win32）+ compaction 组（basic + command-compact + tool-result-pruner）。
5. **权限补充**：`locks.json` 的人锁在面板上以 🔓/🔒 呈现，agent 端 `gate_switch` 仍被 refuse；
   `describe()` 每组新增 `lock` 字段，`planFor` 返回值新增 `locks`。

## 验证

- 离线：`node tests\smoke.mjs` 全绿（含 merge 回归、锁两方向、resume 重放、all-on 复原）。
- Host：`gate.log` 出现 `http api ready at /session-gate/api`。
- API 实测（本会话 `session-b8a28ac2-…`）：
  `GET /state` → `ok=true live=true visible=143821 saved=0 groups=15 recipes=6`；
  gate 1260 B(315 tok) / web 565 B(141) / ego 26,032 B(6,508) / office 8,268 B(2,067)。
- 客户端：`cordis_inspect_query platform=client provider=Slots root='sidebar.right.pane.tab'`
  occupants 末尾出现 `{registrant:'tk', key:'@local/dsh-session-gate', active:true}` ——
  页签类型与两个 keyed 席位都注册成功，client 模块已被页面加载。
- 预设：`Config.listConfigs(name='@deepseek-ai/dsh-agent-preset')` 出现 `include:preset-local`（status schema）。

## 未验证 / 待办

- 面板**视觉**：还没亲眼看到渲染效果（agent 浏览器打开 GUI 被 `dsh web authentication required` 拦住，
  桌面窗口截图被 Edge 挡住；需要用户打开右侧栏确认或桌面窗口前置后截图）。
- `local` 预设的**实际开销**：要开一个新会话选「本地模式」实测工具数/字节，再和闸门方案对比。
- 重启后恢复、与 billion-context 的组合效果（阶段 3）。

## 过程里修掉的问题

- client 里组徽章读的是 `group.risk`，Host 字段是 `risky` → 改为 `risky`（否则「谨慎」徽章永远不显示）。
- client 原样式用了不保证存在的主题令牌（`--dsw-font-*`、`label-tertiary` 等）→ 换成
  `Theme.listTokens` 列出的 `--dsw-alias-*` 与显式字号，避免整条 `font:` 简写失效。

## 实测补充（2026-11-10 22:12）

- 用户肉眼确认面板：15 组按字节降序、6 个配方 chips、每行锁与开关、底部说明都正常。
- 「本地模式」会话 `session-9201fb4e-a216-4bcf-bdad-f3cb3f478304`（Qwen3.5:4b）实测：
  - 开局工具组成 = gate 2 + files 6 + misc 8 + other 1（web / delegate / schedule / skill / plugin / jobs / todo 等均为 0）——**这是 `local` 预设的应然结果**，不是插件没装上（profile 级插件 ego/solidworks/office/board/channels/memory/history/context 仍会挂）
  - 用户在面板里关掉 ego/office/solidworks/board/team/channels/memory/history/context/files 后：
    `visibleBytes=10,715`（≈2,679 token）、`savedBytes=106,440`（≈26.6K token）、全量 117,155
  - 4b 在该会话首轮上下文 13.5K / 32K ≈ 42%，长回答正常 → **目标达成**
- 新增调试端点 `GET /session-gate/api/sessions`：列出所有活会话的 `{id,title,preset,visibleBytes,savedBytes}`，排查「面板数字对不上」时先看它。
- 面板文案：工具数 0 的组显示「本会话没装」，头部加「· 本会话」。
- 教训：会话 `session.v4.jsonl.zstd` header 的 `agentPreset` 字段对本机 local 模式仍写 `"standard"`，**不可用它判断预设**。
