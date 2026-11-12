# 0.3.5 外部试用反馈 · 核查与修复计划（2026-11-12）

> 输入：`dsh-session-gate-0.3.5-反馈报告-2026-11-11(1).md` 与 `(2).md`（两份内容完全相同，17151 B，均在桌面）。
> 来源：一位 DSH 桌面版用户（Windows 11，DSH 0.2.2-rc.1，dsh-plugin 2.3.1，profile `C:\Users\lenovo\.dsh\profiles\desktop`，无 git、`dsh` 不在 PATH）。
> 本文件只做核查与计划；**代码未改、未提交、未推送**。

## 1. 报告结论提炼

| 编号 | 报告主张 | 性质 |
|---|---|---|
| A | 插件功能全部可用（gate_status / gate_plan / gate_switch 往返、状态目录四文件） | ✅ 正面验证 |
| B | README 的安装法在他的机器上三条路全断：无 `plugin_manager` 工具、插件中心 HTTP 只认 npm 包名、桌面版 `lib/desktop-cli.js` 不存在 | 🔴 阻断（文档+交付形态问题） |
| C | 面板拿不到 `props.sessionId` 时静默空白 | 🟡 防御性问题（未证实宿主真的不传） |
| D | 面板/服务端对 `sessionId` 别名不认、无「单活会话」兜底 | 🟡 已在本机复现（见 §2） |
| E | 0.3.6 修复包（zip） | 本机**没有**这个 zip，无法对比；报告 §9 的清单可作设计参考 |

## 2. 本机真机复核（2026-11-12，本机 GUI 端口 59923，插件 0.3.5）

```
GET /session-gate/api/sessions
→ ok=true，2 个活会话：session-3bcc2b80…(visible 140377) / session-b8a28ac2…(visible 118911)

GET /session-gate/api/state?session=<id>
→ ok=true，groups=16   ← 参数名正确时一切正常

GET /session-gate/api/state?sessionId=<id>
→ ok=false, offline=true   ← 别名不认（报告 D 成立）

GET /session-gate/api/state      （无参数）
→ ok=false, offline=true，且**不带** sessions 候选、不带 version   ← 报告 D 成立
```

代码对照（`host/index.js`）：
- `/state` 只读 `url.searchParams.get('session')`（:820），`agents.get(sessionId)` 未命中即 offline（:822-828）。
- `POST /plan|/switch` 未命中同样 409 offline（:852-859、:866-873）。
- `/sessions` 只回 `{ok, sessions}`，没有 `version`（:816）。

代码对照（`host/client.js`）：
- `:158` 无 `sessionId` 直接 return，不取数；`:260` 渲染成「请先打开一个会话」——与报告 §4.1 一致。
- `:381` 起 `ctx.get('sidebarRightTabs'|'slots', false)` 拿不到就静默 return，无 warn。

## 3. 报告里我不同意的两点（不建议照抄 0.3.6 方案）

1. **「唯一活会话就自动接上」对写操作不安全**。右侧栏面板的挂载会话可能是**休眠会话**（切走了、还在看它的页签），而此刻唯一活着的是另一个会话；自动接上会让用户以为在调 A，实际改了 B。建议：
   - GET `/state` 可以兜底，但响应必须带 `fallback:true` 与 `sessionId`，面板顶部明确写「当前显示的是 xxx 的闸门」；
   - **POST `/switch`、`/lock` 不兜底**，缺 session 直接 400 + 候选列表，让用户点选；写错会话的代价远大于多点一下。
2. **`sessionId` 别名可以加，但只作为输入别名**，响应字段保持 `sessionId`（已有），不要两套字段名混用。

## 4. 安装阻断（报告 B）——真实且优先

- 本机 profile 的 `dsh-plugin` 是 **2.3.4**，我的 `plugin_manager` 工具可用（所以本地 README 的写法能跑）；他的 **2.3.1** 没有这个工具，说明「有 `plugin_manager`」不是所有桌面版都成立。
- README 目前只有一条安装路径，且假设该工具存在 → 对陌生用户直接卡死。

修复：
1. README 增加「**没有 `plugin_manager` 时：手工安装**」一节（双写目录 + 改 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` + 重启），并提醒要写 `~/.dsh` 会弹权限框。
2. 仓库根提供 `install.mjs`（不依赖插件宿主工具）：定位 `DSH_HOME`、拷 `host/` 到 `~/.dsh/plugins/dsh-session-gate`、删旧副本再拷到 `profiles/<name>/node_modules/dsh-session-gate`、备份 `package.json` 后补 dependency 与 bundles；支持 `--dry-run` / `--rollback` / `--profile` / `--home`。
3. README 顶部写清「0.3.x 的安装有三种情况」，先判断再操作。

## 5. 修复清单（建议做成 0.3.6）

| 优先级 | 项 | 文件 | 说明 |
|---|---|---|---|
| P0 | 手工安装文档 + `install.mjs` | `README.md`、`host/README.md`、`install.mjs` | 报告 B，挡人 |
| P0 | 面板拿不到 `sessionId` 时不静默：查 `/sessions`，0 个显示「没有运行中的会话」，≥1 个显示可点列表 | `host/client.js` | 报告 C |
| P1 | `/state` 缺参/失效时：单活会话返回 `fallback:true`；多会话返回 offline + `sessions[]` + `hint` | `host/index.js` | 只读兜底，见 §3 |
| P1 | `/sessions` 加 `version`；`gate_status` 输出加 `stateDir`、`bundleVersion` | `host/index.js` | 报 issue 时对账 |
| P2 | `ctx.get` 拿不到 `sidebarRightTabs`/`slots` 时 `console.warn` 一次 | `host/client.js` | 面板不出现时能排查 |
| P2 | 新增 `tests/api.mjs`（loopback 请求全路径断言） | `tests/` | 现在只有 smoke 与 recovery |

## 6. 待用户拍板

1. 是否按 §5 做 0.3.6（我预计 2–3 小时：代码 + 两个测试 + 文档 + 真机验证 + 提交，推送前停）。
2. `install.mjs` 是否允许**自动改 profile 的 `package.json`**（会动 `~/.dsh`，需提权）：是默认自动、还是默认 `--dry-run` 只打印、要用户显式加 `--apply`。
3. 写操作（switch/lock）要不要兜底——我建议不要（§3）。

## 7. 已确认不变的结论

- 报告 §4 原稿「API 对运行中会话报 offline」是**误报**，作者已自行撤回；本机复核也证明给对 `session=` 就正常。
- 报告 §3 的功能数据与我们 2026-11-11 的实测一致（他那边总量 122,569 B ≈ 30,642 token，差异来自他 profile 少几个插件）。
